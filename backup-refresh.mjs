import {readFile,writeFile,rename,stat,unlink} from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
const {saveCollection}=createRequire(import.meta.url)('./staged-import-client.cjs');
const production=(process.env.MACRO_ICE_BASE||'https://macro-ice-production-nov10.jollywood513.chatgpt.site').replace(/\/$/,'');
const legacy='https://macro-ice-observatory.jollywood513.chatgpt.site';
const mode=process.argv[2];
const log=(event,fields={})=>console.log(JSON.stringify({at:new Date().toISOString(),event,...fields}));
const utcDay=t=>t.toISOString().slice(0,10);
const statePath=new URL('./macro-state.json',import.meta.url);
function calendar(date,zone){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
 const p=Object.fromEntries(parts.map(({type,value})=>[type,value]));
 return {date:p.year+'-'+p.month+'-'+p.day,minute:+p.hour*60 + +p.minute,weekday:p.weekday};
}
function scheduled(now){
 for(const [name,zone,minute] of [['full','Europe/London',545],['incremental','America/New_York',615]]){
  const local=calendar(now,zone);
  if(!['Sat','Sun'].includes(local.weekday)&&!['01-01','12-25'].includes(local.date.slice(5))&&local.minute>=minute&&local.minute<minute+120)
   return {name,key:name+'-'+local.date};
 }
 const day=utcDay(now);
 if(now.getUTCHours()===0&&now.getUTCMinutes()>=10)return {name:'full',key:'utc-daily-'+day};
}
async function state(){
 try{return JSON.parse(await readFile(statePath,'utf8'));}
 catch(e){if(e.code==='ENOENT')return {};throw e;}
}
async function save(data){
 const temp=new URL('./macro-state.tmp',import.meta.url);
 await writeFile(temp,JSON.stringify(data));
 await rename(temp,statePath);
}
if(mode==='check'){
 const winter=new Date('2026-11-12T09:05Z'),summer=new Date('2026-07-13T14:15Z');
 if(scheduled(winter)?.name!=='full'||scheduled(summer)?.name!=='incremental'||scheduled(new Date('2026-11-14T00:12Z'))?.key!=='utc-daily-2026-11-14')throw Error('Schedule self-check failed');
 log('schedule-check-passed');
 process.exit(0);
}
// One collection at a time on this PC. A second run that starts while one is active exits quietly instead of
// taking the import lock away from it (that is what caused "Import lock not held by this run" failures).
// A lock older than 14 minutes (longer than any run can last) is treated as left over and replaced.
if(mode==='macro'||mode==='full'||mode==='incremental'){
 const LOCK=new URL('./collect-run.lock',import.meta.url);
 let held=false;
 for(let attempt=0;attempt<2&&!held;attempt++){
  try{await writeFile(LOCK,JSON.stringify({pid:process.pid,mode,at:Date.now()}),{flag:'wx'});held=true;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   let age=0;try{age=Date.now()-(await stat(LOCK)).mtimeMs;}catch{}
   if(age<14*60000){log('skipped',{mode,reason:'another collection is already running'});process.exit(0);}
   await unlink(LOCK).catch(()=>{});
  }
 }
 if(!held){log('skipped',{mode,reason:'could not take the run lock'});process.exit(0);}
 process.on('exit',()=>{try{unlinkSync(LOCK);}catch{}});
}
let schedule, history;
if(mode==='macro'){
 const now=new Date();
 schedule=scheduled(now);
 if(!schedule)process.exit(0);
 history=await state();
 const prior=history[schedule.name];
 if(prior?.key===schedule.key&&(prior.success||Date.now()-prior.started<600000))process.exit(0);
 history[schedule.name]={key:schedule.key,started:Date.now(),success:false};
 await save(history);
}
const input=createInterface({input:process.stdin,terminal:false});
const secret=await new Promise(resolve=>{input.once('line',resolve);input.once('close',()=>resolve(''));});
input.close();
if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error('Production service credential unavailable');
const headers={'OAI-Sites-Authorization':'Bearer '+secret,'X-Macro-ICE-Service':'Bearer '+secret};
async function request(origin,path,body){
 const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',
  headers:{...(origin===production?headers:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(path==='/api/ice/import'?240000:25000)});
 if(!response.ok){
  const error=new Error(path+' HTTP '+response.status);
  error.status=response.status;
  if(response.headers.get('content-type')?.includes('json'))error.detail=(await response.json().catch(()=>null))?.error;
  throw error;
 }
 return path.endsWith('.mjs')?response.text():response.json();
}
const call=(path,body)=>request(production,path,body);
// Staged-import transport: raw responses, optional binary body.
async function stageCall(path,body,responseOnly=false,raw=false){
 const response=await fetch(production+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'})},body:body===undefined?undefined:raw?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(240000)});
 if(responseOnly)return response;
 if(!response.ok)throw Error(path.split('?')[0]+' HTTP '+response.status+' '+(await response.text()).slice(0,160));
 return response.json();
}
async function collect(name){
 const attemptId=crypto.randomUUID();
 await call('/api/ice/attempt',{attemptId,phase:'started',message:'Windows scheduled macro collection'});
 try{
  const [prior,source]=await Promise.all([call('/api/ice/evidence'),call('/api/ice/collector.mjs')]);
  const {collectIceBundle}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const bundle=await collectIceBundle(prior.bundle?.feeds||{});
  const slot=name+'-'+new Date(bundle.capturedAt).toISOString().slice(0,16)+'Z';
  const incoming={...bundle,tradingSlot:slot,expectedRunId:prior.runId??null};
  // The engine is the published Worker source; it evaluates the unchanged v36 rules on this PC.
  await saveCollection({source:await readFile(new URL('./import-engine.js',import.meta.url),'utf8'),incoming,call:stageCall,
   legacyImport:body=>call('/api/ice/import',body),log});
  const health=await call('/api/ice/health');
  const receipt=health.tradingRefresh?.[name];
  if(!receipt||receipt.slot!==slot)throw Error('Missing production receipt for '+slot);
  log('macro-receipt',{slot,runId:receipt.runId,successful:receipt.successful,failed:receipt.failed});
 }catch(e){
  await call('/api/ice/attempt',{attemptId,phase:'failed',message:'Windows macro collection or import failed'}).catch(()=>{});
  throw e;
 }
}
async function relay(){
 const [source,target,sourceTicks,targetTicks]=await Promise.all([
  request(legacy,'/api/broker/latest'),call('/api/broker/latest'),request(legacy,'/api/broker/ticks'),call('/api/broker/ticks')]);
 const newest=feed=>(feed?.rows||[]).reduce((latest,row)=>Math.max(latest,Date.parse(row.retrievedUTC)||0),0);
 const feeds=new Map(target.feeds.map(f=>[f.feedId,f]));
 const ticks=new Map(targetTicks.collectors.map(f=>[f.broker,f]));
 const errors=[],uploads=[],tickUploads=[];
 for(const feed of source.feeds){
  const limit=feed.kind==='quotes'?300000:1800000;
  if(!newest(feed)||Date.now()-newest(feed)>limit||newest(feeds.get(feed.feedId))>=newest(feed))continue;
  try{await call('/api/broker/ingest',feed);uploads.push(feed.feedId);}
  catch(e){if(!(e.status===409&&e.detail==='Older source capture rejected; newer saved market data retained'))errors.push(feed.feedId+' '+e.message);}
 }
 for(const report of sourceTicks.collectors){
  const checked=Date.parse(report.checkedAt);
  if(!Number.isFinite(checked)||checked<=(Date.parse(ticks.get(report.broker)?.checkedAt)||0))continue;
  try{await call('/api/broker/ticks',report);tickUploads.push(report.broker);}
  catch(e){if(e.detail!=='Older tick summary rejected')errors.push(report.broker+' '+e.message);}
 }
 let top;
 try{top=await call('/api/top-markets/refresh',{});}
 catch(e){errors.push('Top Markets '+(e.detail||e.message));}
 log('broker-relay',{uploads,tickUploads,top,errors});
 if(errors.length)process.exitCode=1;
}
try{
 if(mode==='relay')await relay();
 else if(mode==='macro'||mode==='full'||mode==='incremental'){
  await collect(schedule?.name||mode);
  if(schedule){
   history[schedule.name].success=true;
   await save(history);
   if(schedule.key.startsWith('utc-daily-')){
    try{
     const [lab,briefing]=await Promise.all([call('/api/ice/lab'),call('/api/workspace/evidence?days=1')]);
     log('daily-checkpoint',{date:utcDay(new Date()),forecastDates:lab.evaluation?.recordedForecastDates,
       comparisonAvailable:briefing.comparison?.available,previousCapturedAt:briefing.comparison?.previousCapturedAt,
       ingestionDelays:briefing.briefing?.ingestion?.lagging,nextIngestionCheckUtc:briefing.briefing?.ingestion?.nextDailyUtc});
    }catch(e){log('daily-checkpoint-read-failed',{error:e.message});process.exitCode=1;}
   }
  }
 }else throw Error('Unknown scheduler action');
}catch(e){log('failed',{mode,error:e.message});process.exitCode=1;}

