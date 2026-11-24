// Macro ICE - Confluence calibration (no AI usage). Called by alerts.mjs; also runnable by hand: node calibration.mjs
// Logs one reading per pair per hour (weekday London/New York hours) and reports how each kind of call behaved afterwards.
import {readFile,writeFile,appendFile,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const DIR=path.dirname(fileURLToPath(import.meta.url));

// one compact line per pair; conf is alerts.mjs confluenceRow
export function calSnapshot(rows,cx,now,conf){
  const out=[];
  for(const r of rows||[]){
    let c;try{c=conf(r,cx);}catch(e){continue;}
    const h4=((cx.research&&cx.research.structures)||[]).find(s=>s.symbol===r.symbol&&s.timeframe==='H4'&&s.fresh);
    if(!h4||!(h4.lastClose>0)||!(h4.atr14>0))continue;
    out.push(JSON.stringify({t:Math.round(now/60000),s:r.symbol,c:c.call==='TRADE'?'G':c.call==='WAIT'?(c.near?'N':'W'):'A',d:c.dir,f:c.forN,g:c.againstN,p:h4.lastClose,a:+Number(h4.atr14).toPrecision(4)}));
  }
  return out;
}

export function parseLog(text){
  const out=[];
  for(const l of String(text||'').split('\n')){if(!l.trim())continue;let o;try{o=JSON.parse(l);}catch(e){continue;}
    if(o&&typeof o.s==='string'&&Number.isFinite(o.t)&&o.p>0&&o.a>0)out.push(o);}
  return out;
}

// move in ATR in the direction of the call, measured at the first later reading inside a window
export function outcomes(snaps){
  const by=new Map();for(const s of snaps){(by.get(s.s)||by.set(s.s,[]).get(s.s)).push(s);}
  const res=[];
  for(const arr of by.values()){
    arr.sort((a,b)=>a.t-b.t);
    arr.forEach((s,i)=>{
      const find=(lo,hi)=>{for(let j=i+1;j<arr.length;j++){const dt=arr[j].t-s.t;if(dt>hi)break;if(dt>=lo)return arr[j];}return null;};
      const a4=find(240,360),a24=find(1320,1800);
      res.push({...s,m4:a4&&s.d?s.d*(a4.p-s.p)/s.a:null,m24:a24&&s.d?s.d*(a24.p-s.p)/s.a:null});
    });
  }
  return res;
}

const stat=(rows,k)=>{const v=rows.map(r=>r[k]).filter(x=>x!==null&&Number.isFinite(x));return{n:v.length,hit:v.length?100*v.filter(x=>x>0).length/v.length:null,avg:v.length?v.reduce((a,b)=>a+b,0)/v.length:null};};
const fx=(v,d)=>v===null||v===undefined?'–':v.toFixed(d);

export function summarise(snaps){
  const res=outcomes(snaps).filter(r=>r.d!==0);
  const groups=[['Green (all conditions met)',r=>r.c==='G'],['One vote short of green',r=>r.c==='N'],['Wait (other)',r=>r.c==='W'],['Avoid, but with a direction',r=>r.c==='A']].map(([name,fn])=>{const rows=res.filter(fn);return{name,count:rows.length,h4:stat(rows,'m4'),h24:stat(rows,'m24')};});
  const votes=[2,3,4,5,6].map(n=>{const rows=res.filter(r=>r.f===n);return{votes:n,count:rows.length,h4:stat(rows,'m4'),h24:stat(rows,'m24')};});
  const v3=stat(res.filter(r=>r.f===3),'m24'),v4=stat(res.filter(r=>r.f>=4),'m24');
  let verdict;
  if(v3.n<30||v4.n<30)verdict='Not enough readings yet to judge the 4-of-6 rule. About 30 next-day outcomes are needed in each group (3 agreeing votes: '+v3.n+', 4 or more: '+v4.n+'); this usually takes one to two weeks of readings.';
  else if(v3.avg>0&&v3.hit>=50&&v3.avg>=0.7*Math.max(v4.avg,0.0001))verdict='Rows with exactly 3 agreeing votes did nearly as well as rows with 4 or more over the next day (average '+fx(v3.avg,2)+' ATR against '+fx(v4.avg,2)+'). The 4-of-6 rule may be stricter than it needs to be; review before changing anything.';
  else verdict='Rows with 3 agreeing votes did not match rows with 4 or more over the next day (average '+fx(v3.avg,2)+' ATR against '+fx(v4.avg,2)+'). Nothing here suggests the 4-of-6 rule is too strict.';
  const first=snaps.length?Math.min(...snaps.map(s=>s.t)):null,last=snaps.length?Math.max(...snaps.map(s=>s.t)):null;
  const greens=res.filter(r=>r.c==='G').sort((a,b)=>b.t-a.t).slice(0,20);
  return{readings:snaps.length,first,last,groups,votes,verdict,greens};
}

export function renderHtml(sum,now){
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const cell=s=>s.n?fx(s.hit,0)+'% up · '+fx(s.avg,2)+' ATR <small>('+s.n+')</small>':'–';
  const when=t=>new Date(t*60000).toISOString().slice(0,16).replace('T',' ');
  const rows=(a,f)=>a.map(f).join('');
  return '<!doctype html><meta charset="utf-8"><title>Macro ICE - Confluence calibration</title><style>body{font:14px system-ui;background:#0b111b;color:#e5edf8;margin:0;padding:28px;max-width:1000px}h1{font-size:22px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{padding:9px 12px;border-bottom:1px solid #233044;text-align:left}th{color:#8f9fb5;font-size:11px;text-transform:uppercase}small{color:#8f9fb5}p{color:#aebed3;line-height:1.6}.v{background:#16352f;border-left:3px solid #54e2bd;padding:12px 16px;border-radius:6px}</style>'+
  '<h1>Confluence calibration</h1><p>Generated '+esc(new Date(now).toISOString().slice(0,16).replace('T',' '))+' UTC from '+sum.readings+' hourly readings'+(sum.first?' ('+when(sum.first)+' to '+when(sum.last)+' UTC)':'')+'. Each cell: share of calls that moved in the called direction, average move in the called direction measured in H4 ATR, and the number of outcomes in brackets. Research only; past behaviour of a small sample is not a forecast.</p>'+
  '<div class="v">'+esc(sum.verdict)+'</div>'+
  '<h2>By kind of call</h2><table><tr><th>Call at the time</th><th>Readings</th><th>After about 4 hours</th><th>Next day</th></tr>'+rows(sum.groups,g=>'<tr><td>'+esc(g.name)+'</td><td>'+g.count+'</td><td>'+cell(g.h4)+'</td><td>'+cell(g.h24)+'</td></tr>')+'</table>'+
  '<h2>By number of agreeing votes (of 6)</h2><table><tr><th>Agreeing votes</th><th>Readings</th><th>After about 4 hours</th><th>Next day</th></tr>'+rows(sum.votes,g=>'<tr><td>'+g.votes+'</td><td>'+g.count+'</td><td>'+cell(g.h4)+'</td><td>'+cell(g.h24)+'</td></tr>')+'</table>'+
  '<h2>Latest green readings</h2>'+(sum.greens.length?'<table><tr><th>Time (UTC)</th><th>Pair</th><th>Call</th><th>Agreeing / against</th><th>After about 4 hours</th><th>Next day</th></tr>'+rows(sum.greens,r=>'<tr><td>'+when(r.t)+'</td><td>'+esc(r.s)+'</td><td>'+(r.d>0?'Buy':'Sell')+'</td><td>'+r.f+' / '+r.g+'</td><td>'+(r.m4===null?'pending':fx(r.m4,2)+' ATR')+'</td><td>'+(r.m24===null?'pending':fx(r.m24,2)+' ATR')+'</td></tr>')+'</table>':'<p>No green readings logged yet.</p>')+
  '<p><small>Readings are taken once an hour on weekdays between 03:00 and 20:00 New York time while the alert task runs. Pairs without a fresh H4 reading are skipped.</small></p>';
}

export async function writeReport(dir,now){
  const file=path.join(dir,'confluence-log.jsonl');
  const snaps=existsSync(file)?parseLog(await readFile(file,'utf8')):[];
  const sum=summarise(snaps),tmp=path.join(dir,'calibration.tmp');
  await writeFile(tmp,renderHtml(sum,now));await rename(tmp,path.join(dir,'calibration.html'));
  return sum;
}
export async function appendSnapshots(dir,lines){if(lines.length)await appendFile(path.join(dir,'confluence-log.jsonl'),lines.join('\n')+'\n');}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const s=await writeReport(DIR,Date.now());console.log('calibration.html written from '+s.readings+' readings. '+s.verdict);}
