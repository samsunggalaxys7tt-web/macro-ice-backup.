// Reads the open positions from an MT5 Trade report (.xlsx). Same reader as scorecard.mjs, no packages.
import {readFileSync} from 'node:fs';
import {inflateRawSync} from 'node:zlib';
function unzip(buf){
 let e=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-70000);i--)if(buf.readUInt32LE(i)===0x06054b50){e=i;break;}
 if(e<0)throw Error('Not an .xlsx file');
 const count=buf.readUInt16LE(e+10);let p=buf.readUInt32LE(e+16);const out={};
 for(let n=0;n<count;n++){
  if(buf.readUInt32LE(p)!==0x02014b50)throw Error('Bad zip directory');
  const method=buf.readUInt16LE(p+10),csize=buf.readUInt32LE(p+20),nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),off=buf.readUInt32LE(p+42);
  const name=buf.toString('utf8',p+46,p+46+nl);p+=46+nl+el+cl;
  const lnl=buf.readUInt16LE(off+26),lel=buf.readUInt16LE(off+28),start=off+30+lnl+lel,data=buf.subarray(start,start+csize);
  out[name]=()=>method===0?data:inflateRawSync(data);
 }
 return out;
}
function text(b){
 if(b[0]===0xff&&b[1]===0xfe)return b.subarray(2).toString('utf16le');
 if(b[0]===0xfe&&b[1]===0xff){const s=Buffer.from(b.subarray(2));s.swap16();return s.toString('utf16le');}
 return b.toString('utf8').replace(/^﻿/,'');
}
const unent=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(m,d)=>String.fromCharCode(+d)).replace(/&amp;/g,'&');
function readSheet(file){
 const z=unzip(readFileSync(file)),shared=[];
 if(z['xl/sharedStrings.xml'])for(const m of text(z['xl/sharedStrings.xml']()).matchAll(/<si>([\s\S]*?)<\/si>/g))shared.push(unent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join('')));
 const name=Object.keys(z).find(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n));if(!name)throw Error('No worksheet found');
 const xml=text(z[name]()),rows=[];
 for(const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
  const row={};
  for(const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
   const ref=/r="([A-Z]+)\d+"/.exec(c[1]);if(!ref||c[2]===undefined)continue;
   const t=/t="(\w+)"/.exec(c[1])?.[1],v=/<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1];
   let val;
   if(t==='s')val=shared[+v];else if(t==='inlineStr')val=unent([...c[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join(''));
   else if(t==='str')val=unent(v??'');else if(v!==undefined)val=Number(v);
   if(val!==undefined&&val!=='')row[ref[1]]=val;
  }
  rows.push(row);
 }
 return rows;
}
const num=v=>v===undefined||v===''?null:Number(String(v).replace(/\s/g,''));
// Finds the table whose header row has these names, then reads rows until the first row without a date/position.
function table(rows,mustHave,rowOk){
 const hi=rows.findIndex(r=>mustHave.every(h=>Object.values(r).includes(h)));if(hi<0)return null;
 const cols=Object.fromEntries(Object.entries(rows[hi]).map(([k,v])=>[k,v]));const byName={};
 const seen={};for(const [k,v] of Object.entries(cols)){seen[v]=(seen[v]||0)+1;byName[v+(seen[v]>1?'#'+seen[v]:'')]=k;}
 const out=[];
 for(const r of rows.slice(hi+1)){const o={};for(const [n,k] of Object.entries(byName))o[n]=r[k];if(!rowOk(o))break;out.push(o);}
 return out;
}
const parseTime=s=>{const m=/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s||''));return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):null;};
export function readOpen(file){
 const rows=readSheet(file);
 const t=table(rows,['Symbol','Position','Time','Type','Volume'],o=>typeof o.Time==='string'&&/^\d{4}\./.test(o.Time));
 if(!t)return null;
 return t.map(o=>({sym:String(o.Symbol).toUpperCase(),type:String(o.Type).toLowerCase(),vol:num(o.Volume),open:parseTime(o.Time),sl:num(o['S / L']),tp:num(o['T / P']),px:num(o['Market Price']),entry:num(o.Price),p:num(o.Profit)||0,pos:o.Position}));
}


