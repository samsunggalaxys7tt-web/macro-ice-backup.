// Runs the unchanged v36 import calculations on the collector PC and sends the result to the
// Worker in bounded parts (staged import). `call(path, body, responseOnly, raw)` performs one
// authorised request to the site.
const vm=require('node:vm'),{webcrypto,randomUUID}=require('node:crypto');

// Refusal codes from the Worker. Only `import-in-progress` is worth one retry.
class ImportRefused extends Error{constructor(message,code,status,retryAfterSeconds){super(message);this.code=code;this.status=status;this.retryAfterSeconds=retryAfterSeconds;}}
async function refusal(r,what){
 let body=null;try{body=await r.json();}catch{}
 return new ImportRefused(what+' HTTP '+r.status+' '+(body?.error||''),body?.code||null,r.status,body?.retryAfterSeconds??null);
}
// Version tags are read from a JSON body or X-Ice-Etag, never only from the standard ETag
// header: a proxy between the Worker and this PC may drop or rewrite that header (v38 failure).
const cleanTag=t=>typeof t==='string'&&t?t.replace(/^W\//,'').replace(/^"|"$/g,''):null;

async function stagedImport({source,incoming,call,now=incoming.capturedAt}){
 const run=randomUUID(),base='/api/ice/import-stage/',pending=new Map(),seen=new Map();
 const endpoint=(op,extra='')=>base+op+'?run='+run+extra;
 const begun=await call(endpoint('begin'),{},true);
 if(!begun.ok){const e=await refusal(begun,'begin');if(begun.status===404||begun.status===405)e.code='staged-unsupported';throw e;}
 const beginInfo=await begun.json();
 try{
  // First read of each key is kept, so the evaluation sees one consistent version per object.
  const fetchObject=async key=>{
   if(pending.has(key))return pending.get(key);
   if(seen.has(key))return seen.get(key);
   const r=await call(endpoint('read','&key='+encodeURIComponent(key)),undefined,true);
   if(r.status===404){seen.set(key,null);return null;}
   if(!r.ok)throw await refusal(r,'Staged read');
   const text=await r.text();
   let etag=cleanTag(r.headers.get('x-ice-etag'))||cleanTag(r.headers.get('etag'));
   if(!etag){const h=await call(endpoint('head','&key='+encodeURIComponent(key)),undefined,true);if(!h.ok)throw await refusal(h,'Staged head');etag=cleanTag((await h.json())?.etag);}
   if(!etag)throw Error('Snapshot version tag unavailable for '+key);
   const o={text,etag};seen.set(key,o);return o;
  };
  const bucket={
   async get(key){const o=await fetchObject(key);return o?{etag:o.etag||'pending',body:Buffer.from(o.text),json:async()=>JSON.parse(o.text),text:async()=>o.text}:null;},
   async head(key){const o=await fetchObject(key);return o?{etag:o.etag||'pending'}:null;},
   async put(key,value,options){
    // Local conditional checks compare against the version this run read. The Worker repeats
    // the authoritative check against live storage at commit.
    if(options?.onlyIf?.etagDoesNotMatch==='*'&&await fetchObject(key))return null;
    if(options?.onlyIf?.etagMatches){const old=await fetchObject(key);if(old?.etag!==options.onlyIf.etagMatches)return null;}
    const text=typeof value==='string'?value:Buffer.from(value instanceof ArrayBuffer||ArrayBuffer.isView(value)?value:await new Response(value).arrayBuffer()).toString('utf8');
    pending.set(key,{text,options});return {etag:'pending'};
   },
   async list({prefix='',limit=1000}={}){const r=await call(endpoint('list','&prefix='+encodeURIComponent(prefix)+'&limit='+limit),undefined,true);if(!r.ok)throw await refusal(r,'Staged list');const result=await r.json();const map=new Map(result.objects.map(o=>[o.key,o]));for(const key of pending.keys())if(key.startsWith(prefix))map.set(key,{key});return {objects:[...map.values()].slice(0,limit),truncated:result.truncated};}
  };
  const context=vm.createContext({console,Request,Response,URL,URLSearchParams,TextEncoder,TextDecoder,crypto:webcrypto,structuredClone,atob,btoa,AbortSignal,setTimeout,clearTimeout,DecompressionStream,CompressionStream,fetch:async()=>{throw Error('Network collection is forbidden during import evaluation');}});
  context.replayTime=now;
  const code=source.replace(/^export default /m,'globalThis.worker = ').replace(/^export /gm,'');
  vm.runInContext('const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[globalThis.replayTime]));}static now(){return NativeDate.parse(globalThis.replayTime);}};'+code+'\nglobalThis.importCollection=iceRefresh;',context,{timeout:30000});
  const result=await context.importCollection({BUCKET:bucket},incoming);
  // No new snapshot means v36's unchanged-input receipt; persist the staged small metadata separately.
  if(!pending.has('ice/latest.json')){const prior=await fetchObject('ice/latest.json');if(!prior)throw Error('Missing prior snapshot');pending.set('ice/latest.json',{text:prior.text});}
  const baseTag=seen.get('ice/latest.json')?.etag??beginInfo.etag??null;
  const objects=[];let index=0;
  for(const [key,o]of pending){const bytes=Buffer.from(o.text),indices=[];
   for(let offset=0,part=1;offset<bytes.length;offset+=5*1024*1024,part++){
    const chunk=bytes.subarray(offset,offset+5*1024*1024),n=index++;indices.push(n);
    await call(endpoint('part','&index='+n),chunk,false,true);
    await call(endpoint('batch'),{index:n,key,part,size:chunk.length});
   }
   const options=o.options?.onlyIf?.etagDoesNotMatch==='*'?{onlyIf:{etagDoesNotMatch:'*'}}:undefined;
   objects.push({key,indices,...(options?{options}:{})});
  }
  await call(endpoint('commit'),{objects,count:index,base:baseTag});
  return result;
 }catch(e){
  // Release this run's lock so the next collector need not wait for it to expire.
  try{await call(endpoint('abort'),{},true);}catch{}
  throw e;
 }
}

// Saves one collection. Staged import first; if this site version has no staged import, the
// original single-request /api/ice/import. A refusal because another import is in progress is
// retried once after `retryDelayMs`; every other failure is reported unchanged.
async function saveCollection({source,incoming,call,legacyImport,now,retryDelayMs=60000,wait=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{}}){
 for(let attempt=1;;attempt++){
  try{
   try{return await stagedImport({source,incoming:structuredClone(incoming),call,now:now??new Date().toISOString()});}
   catch(e){if(e.code!=='staged-unsupported')throw e;log('staged-import-unavailable',{});return await legacyImport(incoming);}
  }catch(e){
   const busy=e.code==='import-in-progress'||(e.status===409&&e.detail==='Import in progress');
   if(!busy||attempt>1)throw e;
   log('import-refused-retrying',{attempt,waitMs:retryDelayMs,retryAfterSeconds:e.retryAfterSeconds??null});
   await wait(retryDelayMs);
  }
 }
}
module.exports={stagedImport,saveCollection,ImportRefused};
