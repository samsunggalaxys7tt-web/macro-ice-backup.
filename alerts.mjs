// Macro ICE green-light alerts - runs on this PC every 5 minutes, uses no Claude and no credentials (read-only public endpoints).
// Tells you when a pair (or gold, silver, the dollar index, oil) NEWLY turns green with a Buy or Sell bias on the Trade readiness panel,
// and names any central bank decision or major release due in the next 24 hours so you know the risk before you act.
// Batch 54: also tells you when a candlestick or market-maker pattern CONFIRMS a green Buy or Sell, and says WAIT / CAUTION when one goes against it.
// Batch 66: the pop-up box shows the first three lines plus "+N more" (the phone and the log carry the full list), and the log records whether the phone service accepted each notice.
// Batch 64: WATCH notice when a pair closes outside the Asian range during London (a Type 1 M/W setup may form; not a trade call) and one London-open summary a day.
// Batch 67: NEAR GREEN notice (a pair one vote short of green on the Confluence board; London and New York morning, once per pair per day, max three listed) and a Sunday WEEK AHEAD notice (about 16:00 Trinidad time).
// Batch 67: CONFLUENCE GREEN notice when a pair turns green on the Confluence board (03:00-20:00 New York, weekdays, once per turn; same pair and side not repeated within 6 hours).
//           Create alerts-no-confgreen.txt (any content) to turn it off.
//           Create alerts-no-near.txt (any content) next to this script to turn the NEAR GREEN notices off.
// Output: Windows balloon notice, optional phone notice (ntfy), logs\alerts-YYYY-MM-DD.log, alerts-state.json.
// Batch 72: ALERTS_CLOUD=1 (set by the GitHub Actions copy that covers you while the PC is off) skips the Windows pop-ups and, before each phone notice, drops any line the phone topic already received in the last 6 hours (so the PC and the cloud copy never double-send).
// Options:  --test  sends a test notice;  --list  prints what is green right now (no notice, state untouched).
// Optional files next to this script: alerts-watch.txt (one symbol per line; empty or missing = alert on everything),
//                                     alerts-no-popup.txt (create it, any content, to turn the pop-up box off and keep only the balloon / phone notice),
//                                     ntfy-topic.txt (one line, your private ntfy topic name, to get the same notice on your phone).
import {readFile,writeFile,appendFile,mkdir,rename,readdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {calSnapshot,appendSnapshots,writeReport} from './calibration.mjs';

const DIR=process.env.ALERTS_DIR||path.dirname(fileURLToPath(import.meta.url));
const BASE=(process.env.ALERTS_BASE||'https://macro-ice-production-nov10.jollywood513.chatgpt.site').replace(/\/$/,'');
const REPEAT_MS=6*3600000; // the same pair and direction is not announced again within 6 hours
const ASSET_DEFS=[['XAU','Gold'],['XAG','Silver'],['DXY','US Dollar Index'],['OIL','Oil']]; // yields are green/amber only, with no Buy or Sell, so they are not alerted

// ---- exact copies of the dashboard's Trade readiness rules (Batch 41 + 45 + 46) ----
export function fxLight(r){
  if(!r.macro||!r.macro.eligible)return{color:'red'};
  const gaps=[];
  if(!r.tactical||!r.tactical.ok)gaps.push('tactical');
  if(!r.weekly||!r.weekly.ok)gaps.push('weekly');
  if(!r.macro||(r.macro.bias!=='Bullish'&&r.macro.bias!=='Bearish'))gaps.push('bias');
  if(r.alignment&&r.alignment.selected==='Conflicted')gaps.push('conflicted');
  // Batch 45: not green when price is moving against the bias (weekly countertrend and an H4 range break the wrong way)
  const h4=r.execution&&r.execution.h4,h4dir=h4&&h4.ok?h4.direction:null,wkAgainst=!!(r.alignment&&r.alignment.weekly==='Countertrend');
  if(wkAgainst&&((r.macro.bias==='Bullish'&&h4dir==='Downward range break')||(r.macro.bias==='Bearish'&&h4dir==='Upward range break')))gaps.push('against');
  return gaps.length?{color:'amber',gaps}:{color:'green'};
}
export function assetLight(x){
  if(!x||x.score==null||x.confidence<40||x.coverage<60)return{color:'red'};
  if(x.confidence>=55&&x.coverage>=70&&x.bias!=='Balanced')return{color:'green'};
  return{color:'amber'};
}
export const word=bias=>bias==='Bullish'?'Buy':bias==='Bearish'?'Sell':null;

// ---- event risk (same rule as the dashboard's Batch 44) ----
const CENTRAL=/(interest|policy|funds|cash|refinancing|bank) rate|rate statement|rate decision|monetary policy|fomc|press conference|\bmpc\b|official cash rate|speaks/i;
const NAMES={policy:'central bank decision',inflation:'CPI',growth:'GDP',jobs:'jobs report'};
export function eventRisk(ccys,now,hours,calendar,evidence){
  const want=new Set((ccys||[]).filter(Boolean)),end=now+hours*3600000,grace=15*60000,list=[];
  const calOk=!!calendar&&Array.isArray(calendar.events)&&Number.isFinite(Date.parse(calendar.retrievedAt))&&now-Date.parse(calendar.retrievedAt)<=24*3600000;
  if(calOk)for(const e of calendar.events){
    if(!want.has(e.country)||!/^high$/i.test(e.impact||''))continue;
    const t=Date.parse(e.date);if(!Number.isFinite(t)||t<now-grace||t>end)continue;
    list.push({ccy:e.country,title:e.title,at:t,approx:false,kind:CENTRAL.test(e.title||'')?'central bank':'release'});
  }
  for(const r of evidence||[]){
    if(!want.has(r.ccy)||!NAMES[r.indicator])continue;
    const title=NAMES[r.indicator],kind=r.indicator==='policy'?'central bank':'release',exact=Date.parse(r.expectedReleaseAt);
    if(Number.isFinite(exact)){
      if(exact<now-grace||exact>end)continue;
      if(list.some(x=>x.ccy===r.ccy&&Math.abs(x.at-exact)<=3*3600000&&(x.kind===kind||kind==='release')))continue;
      list.push({ccy:r.ccy,title,at:exact,approx:false,kind});continue;
    }
    const day=/^\d{4}-\d{2}-\d{2}$/.test(String(r.nextReleaseDate||''))?r.nextReleaseDate:null;if(!day)continue;
    const start=Date.parse(day+'T00:00:00Z'),stop=start+86400000;
    if(stop<=now||start>end)continue;
    if(list.some(x=>x.ccy===r.ccy&&new Date(x.at).toISOString().slice(0,10)===day&&(x.kind===kind||kind==='release')))continue;
    list.push({ccy:r.ccy,title,at:Math.max(start,now),approx:true,day,kind});
  }
  list.sort((p,q)=>p.at-q.at);
  return {events:list};
}
export function eventIn(e,now){
  if(e.approx)return(e.day===new Date(now).toISOString().slice(0,10)?'today':'tomorrow');
  const m=Math.ceil((e.at-now)/60000);
  return m<=0?'now':m<60?m+'m':Math.floor(m/60)+'h '+m%60+'m';
}

// ---- what is green right now ----
// Batch 46: a central bank decision (not a speech) for either currency within 24 hours keeps a pair out of green until it has passed
export function decisionAhead(ccys,now,calendar,evidence){
  return eventRisk(ccys,now,24,calendar,evidence).events.find(e=>e.kind==='central bank'&&!/speaks/i.test(e.title||''));
}
export function currentGreens(rows,assets,calendar,evidence,now){
  const out={};
  for(const r of rows||[]){
    const l=fxLight(r);if(l.color!=='green')continue;
    const ccys=[r.symbol.slice(0,3),r.symbol.slice(3,6)];
    if(now!=null&&decisionAhead(ccys,now,calendar,evidence||[]))continue;
    out[r.symbol]={dir:word(r.macro.bias),ccys};
  }
  for(const [id,label] of ASSET_DEFS){
    const a=(assets||[]).find(x=>x.id===id);
    if(a&&assetLight(a).color==='green')out[label]={dir:word(a.bias),ccys:['USD']};
  }
  return out;
}
// decides which greens are news: new green, or green with a changed direction, and not repeated inside REPEAT_MS
export function newAlerts(greens,prev,now,watch){
  const fresh=[],notified={...(prev.notified||{})};
  for(const [key,g] of Object.entries(greens)){
    if(watch&&watch.length&&!watch.includes(key))continue;
    if(!g.dir)continue;
    const was=prev.lights&&prev.lights[key];
    if(was&&was.dir===g.dir)continue;
    const last=notified[key];
    if(last&&last.dir===g.dir&&now-last.at<REPEAT_MS)continue;
    fresh.push({key,...g});notified[key]={dir:g.dir,at:now};
  }
  return {fresh,notified};
}
// Batch 47: exit alerts (a green that is no longer green) and a 60-minute heads-up before a central bank decision
const ccysOf=k=>/^[A-Z]{6}$/.test(k)?[k.slice(0,3),k.slice(3,6)]:['USD'];
export function exitAlerts(prevLights,greens,now,calendar,evidence,watch){
  const out=[];
  for(const k of Object.keys(prevLights||{})){
    if(greens[k]||(watch&&watch.length&&!watch.includes(k)))continue;
    const d=decisionAhead(ccysOf(k),now,calendar,evidence||[]);
    out.push(k+' is no longer GREEN — '+(d?'central bank decision ahead: '+d.ccy+' '+(d.approx?eventIn(d,now):'in '+eventIn(d,now)):'its rules are no longer met, check the dashboard'));
  }
  return out;
}
export function headsUp(ccys,now,calendar,evidence,sent){
  const out=[],keys={};
  for(const e of eventRisk(ccys,now,1,calendar,evidence||[]).events){
    if(e.kind!=='central bank'||e.approx||/speaks/i.test(e.title||'')||e.at<now)continue;
    const key=e.ccy+'|'+e.at;if(sent&&sent[key])continue;
    keys[key]=now;out.push('HEADS-UP: '+e.ccy+' '+e.title+' in '+eventIn(e,now)+' — expect a price spike');
  }
  return {lines:out,keys};
}
// Batch 49: warns when an open MT5 position is on the opposite side of the dashboard's current bias for that pair (announced once until it clears)
export function positionAlerts(positions,rows,prevAgainst){
  const against={},lines=[];
  for(const p of positions||[]){
    const r=(rows||[]).find(x=>x.symbol===p.sym);if(!r||!r.macro||!r.macro.eligible)continue;
    const bias=r.macro.bias,want=p.type==='buy'?'Bullish':'Bearish';
    if((bias==='Bullish'||bias==='Bearish')&&bias!==want){
      const key=p.sym+'|'+p.type;
      if(against[key])continue;
      against[key]=1;
      if(!prevAgainst||!prevAgainst[key])lines.push('OPEN '+p.sym+' '+p.type.toUpperCase()+': the dashboard bias is now '+bias+(p.sl==null?' (and this position has no stop)':''));
    }
  }
  return {lines,against};
}
async function latestPositions(now){
  try{
    const dir=path.join(DIR,'trade-reports'),files=(await readdir(dir)).filter(f=>/^ReportTrade-.*\.xlsx$/i.test(f));
    let best=null;for(const f of files){const s=await stat(path.join(dir,f));if(!best||s.mtimeMs>best.m)best={f,m:s.mtimeMs};}
    if(!best||now-best.m>48*3600000)return null;
    const lib=await import(pathToFileURL(path.join(DIR,'positions-lib.mjs')).href);
    return lib.readOpen(path.join(dir,best.f));
  }catch{return null;}
}
// Batch 54: pattern confirmation and WAIT / CAUTION alerts. Needs the dashboard to carry Batch 54 (patterns in /api/ice/research); without it nothing here fires.
const DIRECTIONAL=b=>b==='Bullish'||b==='Bearish';
export function patternReads(sym,research){
  const reads=[];if(!research)return reads;
  const add=(tf,label,bias,at)=>{if(DIRECTIONAL(bias))reads.push({tf,label,bias,id:[sym,tf,label,bias,at||''].join('|')});};
  const d=research.patternsD1&&research.patternsD1[sym];
  if(d){
    for(const p of d.patterns||[])if(p.barsAgo===0)add('D1',p.name,p.bias,p.end);
    if(d.pushes&&DIRECTIONAL(d.pushes.bias))add('D1','3 pushes '+(d.pushes.bias==='Bearish'?'up':'down')+' (reversal due)',d.pushes.bias,'');
    if(d.sweep&&d.sweep.barsAgo===0)add('D1','stop hunt '+d.sweep.side.toLowerCase(),d.sweep.bias,String(d.sweep.level));
  }
  for(const s of research.structures||[]){
    if(s.symbol!==sym||!Array.isArray(s.patterns))continue;
    if(s.timeframe==='H4'){
      for(const p of s.patterns)if(p.barsAgo===0)add('H4',p.name,p.bias,p.end);
      const m=s.mm;if(m){
        if(m.pushes&&DIRECTIONAL(m.pushes.bias))add('H4','3 pushes '+(m.pushes.bias==='Bearish'?'up':'down')+' (reversal due)',m.pushes.bias,'');
        if(m.sweep&&m.sweep.barsAgo===0)add('H4','stop hunt '+m.sweep.side.toLowerCase(),m.sweep.bias,String(m.sweep.level));
      }
    }
    if(s.timeframe==='H1'&&s.mm&&s.mm.session&&s.mm.session.mw&&/^Confirmed/.test(s.mm.session.mw.state)){const w=s.mm.session.mw;add('H1',w.shape+' pattern '+w.type.split(' (')[0]+' confirmed',w.bias,String(w.neckline));}
  }
  return reads;
}
export function patternAlerts(greens,research,prevPats,now){
  const pats={},lines=[];
  for(const [id,t] of Object.entries(prevPats||{}))if(now-t<72*3600000)pats[id]=t;
  for(const [key,g] of Object.entries(greens||{})){
    if(!/^[A-Z]{6}$/.test(key)||!g.dir)continue;
    const macro=g.dir==='Buy'?'Bullish':'Bearish',side=g.dir.toUpperCase();
    for(const r of patternReads(key,research)){
      if(pats[r.id])continue;
      pats[r.id]=now;
      if(r.bias===macro)lines.push(side+' SIGNAL CONFIRMED: '+key+' — '+r.tf+' '+r.label+' agrees with the green '+side);
      else lines.push('WAIT / CAUTION: '+key+' is GREEN '+side+' but a '+r.tf+' '+r.label+' ('+r.bias.toLowerCase()+') points the other way — consider waiting');
    }
  }
  return {lines:lines.slice(0,6),pats};
}
// Batch 64: New York clock helper, Asian-range break watch and the London-open summary (both are information only, never trade calls and never change a light)
export function nyParts(now){
  const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour12:false}).formatToParts(new Date(now)),g=t=>f.find(x=>x.type===t).value;
  let h=Number(g('hour'));if(h===24)h=0;
  return{h,m:Number(g('minute')),date:g('year')+'-'+g('month')+'-'+g('day'),dow:g('weekday')};
}
export function asianBreakAlerts(research,now,prevBreaks,watch){
  const lines=[],breaks={};
  for(const [id,t] of Object.entries(prevBreaks||{}))if(now-t<36*3600000)breaks[id]=t;
  const date=nyParts(now).date,fresh=[];
  for(const s of (research&&research.structures)||[]){
    if(s.timeframe!=='H1'||s.fresh===false||!s.mm||!s.mm.session||!s.mm.session.asia||s.mm.session.session!=='London')continue;
    if(watch&&watch.length&&!watch.includes(s.symbol))continue;
    const a=s.mm.session.asia,c=s.lastClose;if(!(c>0)||!(a.high>a.low))continue;
    const side=c>a.high?'high':c<a.low?'low':null;if(!side)continue;
    const id=s.symbol+'|'+date+'|'+side;if(breaks[id])continue;
    breaks[id]=now;fresh.push('WATCH: '+s.symbol+' closed '+(side==='high'?'above':'below')+' the Asian range '+side+' ('+(side==='high'?a.high:a.low)+') in London — a Type 1 M/W setup may form. Not a trade call.');
  }
  lines.push(...fresh.slice(0,4));if(fresh.length>4)lines.push('WATCH: '+(fresh.length-4)+' more pairs closed outside the Asian range — see the dashboard');
  return {lines,breaks};
}
export function londonSummary(rows,research,calendar,evidence,now,prevDay){
  const p=nyParts(now);
  if(p.h<3||p.h>=5||prevDay===p.date)return null;
  let green=[],amber=0,red=0;
  for(const r of rows||[]){const l=fxLight(r);
    if(l.color==='green'&&!decisionAhead([r.symbol.slice(0,3),r.symbol.slice(3,6)],now,calendar,evidence||[]))green.push(r.symbol+' '+String(word(r.macro.bias)||'').toUpperCase());
    else if(l.color==='red')red++;else amber++;}
  const lines=['LONDON OPEN SUMMARY: '+green.length+' green'+(green.length?' ('+green.slice(0,6).join(', ')+(green.length>6?', …':'')+')':'')+', '+amber+' amber, '+red+' red (Trade readiness lights).'];
  const mw=[];for(const s of (research&&research.structures)||[]){if(s.timeframe==='H1'&&s.mm&&s.mm.session&&s.mm.session.mw)mw.push({sym:s.symbol,...s.mm.session.mw});}
  if(mw.length){const conf=mw.filter(w=>/^Confirmed/.test(w.state));
    lines.push('M/W patterns tracked: '+mw.length+', '+conf.length+' confirmed'+(conf.length?' ('+conf.slice(0,3).map(w=>w.sym+' '+w.shape+' '+String(w.type).split(' (')[0]+(w.score!=null?', '+w.score+' of 5 checks':'')).join('; ')+')':'')+'. Reference only.');}
  const ev=eventRisk(['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'],now,12,calendar,evidence||[]).events;
  if(ev.length)lines.push('Event risk next 12h: '+ev.slice(0,4).map(e=>e.ccy+' '+e.title+' '+(e.approx?eventIn(e,now):'in '+eventIn(e,now))).join('; ')+'.');
  return {lines,day:p.date};
}
// Batch 67: the Confluence board's six votes, ported line for line from the dashboard page, so a phone notice can say a pair is ONE VOTE SHORT of green.
// A test (test-alerts.mjs) runs the dashboard's own code against this one on the same inputs and requires identical results. Information only; never a trade call.
export function cotMapFrom(workspaceEvidence,fredSaved){
  const m={},ev=workspaceEvidence&&workspaceEvidence.cot;
  if(Array.isArray(ev))for(const r of ev)if(r&&r.last&&Number.isFinite(r.last.v))m[r.ccy]={net:r.last.v,change:Number.isFinite(r.change)?r.change:null,pct:Number.isFinite(r.percentile)?r.percentile:null};
  const c=fredSaved&&fredSaved.cot&&fredSaved.cot.rows;if(c)for(const k of Object.keys(c))if(!m[k]&&c[k]&&Number.isFinite(c[k].netPct))m[k]={net:c[k].netPct,change:null,pct:null};
  return m;
}
export function confluenceRow(row,ctx){
  const R=ctx.research||{},cot=ctx.cot||{},now=ctx.now,sym=row.symbol,base=sym.slice(0,3),quote=sym.slice(3,6),sg=b=>b==='Bullish'?1:b==='Bearish'?-1:0;
  const inp=[],add=(key,label,vote)=>inp.push({key,label,vote});
  add('macro','Macro (ICE)',row.macro&&row.macro.eligible?sg(row.macro.bias):0);
  add('weekly','Weekly trend',row.weekly&&row.weekly.ok?(row.weekly.direction==='Higher'?1:row.weekly.direction==='Lower'?-1:0):0);
  const h4=(R.structures||[]).find(s=>s.symbol===sym&&s.timeframe==='H4'&&s.fresh);
  let pv=0;
  if(h4)pv=h4.direction==='Upward range break'?1:h4.direction==='Downward range break'?-1:0;
  else if(row.tactical&&row.tactical.ok&&Number.isFinite(row.tactical.value)&&Math.abs(row.tactical.value)>0)pv=row.tactical.value>0?1:-1;
  add('price','Price action',pv);
  let cs=0;const w={D1:3,H4:2,H1:1},pl=[],d1=R.patternsD1&&R.patternsD1[sym];
  if(d1&&Array.isArray(d1.patterns))for(const p of d1.patterns)pl.push({tf:'D1',p});
  for(const s of R.structures||[])if(s.symbol===sym&&(s.timeframe==='H4'||s.timeframe==='H1')&&Array.isArray(s.patterns))for(const p of s.patterns)pl.push({tf:s.timeframe,p});
  pl.filter(x=>x.p.barsAgo===0&&(x.p.bias==='Bullish'||x.p.bias==='Bearish')).forEach(x=>{cs+=sg(x.p.bias)*(w[x.tf]||1)*(x.p.strong?1.5:1);});
  add('candle','Candlestick patterns',cs>0?1:cs<0?-1:0);
  let mm=0;const mmAdd=b=>{const v=sg(b);if(v)mm+=v;};
  for(const s of R.structures||[])if(s.symbol===sym&&s.mm&&(s.timeframe==='H1'||s.timeframe==='H4')){const m=s.mm;
    if(m.session&&m.session.mw)mmAdd(m.session.mw.bias);
    if(m.pushes&&m.pushes.bias&&m.pushes.bias!=='None')mmAdd(m.pushes.bias);
    if(m.wedge)mmAdd(m.wedge.bias);if(m.sweep)mmAdd(m.sweep.bias);if(m.reset)mmAdd(m.reset.bias);}
  const d1b=R.patternsD1&&R.patternsD1[sym];
  if(d1b){if(d1b.pushes&&d1b.pushes.bias&&d1b.pushes.bias!=='None')mmAdd(d1b.pushes.bias);if(d1b.sweep)mmAdd(d1b.sweep.bias);if(d1b.reset)mmAdd(d1b.reset.bias);if(d1b.weekly)mmAdd(d1b.weekly.bias);}
  add('mm','Market-maker cycle',mm>0?1:mm<0?-1:0);
  const ca=cot[base],cb=cot[quote],lean=c=>c&&Math.abs(c.net)>=5?(c.net>0?1:-1):0;
  let cv=lean(ca)-lean(cb);cv=cv>0?1:cv<0?-1:0;
  const crowd=(c,dirn)=>c&&c.pct!==null&&((dirn>0&&c.pct>=90)||(dirn<0&&c.pct<=10));
  if(cv>0&&crowd(ca,1))cv=0;if(cv<0&&crowd(ca,-1))cv=0;
  add('cot','Positioning (COT)',cv);
  const naN=(ca||cb?0:1)+(row.weekly&&row.weekly.ok?0:1)+(h4||(row.tactical&&row.tactical.ok)?0:1);
  inp.forEach(x=>{x.na=(x.key==='cot'&&!(ca||cb))||(x.key==='weekly'&&!(row.weekly&&row.weekly.ok))||(x.key==='price'&&!h4&&!(row.tactical&&row.tactical.ok));});
  const avail=6-naN,need=avail>=6?4:3;
  const bull=inp.filter(x=>x.vote>0).length,bear=inp.filter(x=>x.vote<0).length,dir=bull>bear?1:bear>bull?-1:0;
  const forN=dir>0?bull:dir<0?bear:0,againstN=dir>0?bear:dir<0?bull:0;
  const evs=eventRisk([base,quote],now,24,ctx.calendar,ctx.evidence||[]).events,high=evs.some(e=>e.kind==='central bank'||e.at-now<=4*3600000);
  const ev={level:evs.length?(high?'high':'watch'):'none'};
  const atr=h4?h4.atr14:null,px=h4&&h4.lastClose>0?h4.lastClose:null;
  let qr='na';
  const MAJ=['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
  if(dir&&atr>0&&px&&MAJ.includes(base)&&MAJ.includes(quote)){const pip=quote==='JPY'?0.01:0.0001,p=px/pip,below=Math.floor(p/250+1e-9)*250,above=below+250,next=dir>0?above:(Math.ceil(p/250-1e-9)-1)*250,away=Math.abs(next-p),r=away/(atr/pip);qr=r>=3?'room':r>=1.5?'some':'blocked';}
  let call='AVOID',near=false;
  if(!(row.macro&&row.macro.eligible))call='AVOID';
  else if(dir===0)call=bull+bear>=2?'WAIT':'AVOID';
  else{
    const okGates=ev.level!=='high'&&qr!=='blocked';
    if(forN>=need&&againstN<=1&&okGates)call='TRADE';
    else if(forN>=need-1&&againstN<=2){call='WAIT';near=forN===need-1&&againstN<=1&&okGates;}
    else call='AVOID';
  }
  return{symbol:sym,call,light:call==='TRADE'?'green':call==='WAIT'?'amber':'red',dir,forN,againstN,avail,need,near,missing:inp.filter(x=>x.vote===0&&!x.na).map(x=>x.label)};
}
export function nearGreenAlerts(rows,ctx,prevNear,watch,off){
  const lines=[],near={},now=ctx.now,p=nyParts(now);
  for(const [id,t] of Object.entries(prevNear||{}))if(now-t<36*3600000)near[id]=t;
  if(off||p.h<3||p.h>=12||p.dow==='Sat'||p.dow==='Sun')return {lines,near};
  const fresh=[];
  for(const r of rows||[]){
    if(watch&&watch.length&&!watch.includes(r.symbol))continue;
    let c;try{c=confluenceRow(r,ctx);}catch(e){continue;}
    if(!c.near)continue;
    const id=c.symbol+'|'+p.date+'|'+(c.dir>0?'Buy':'Sell');if(near[id])continue;
    near[id]=now;fresh.push('NEAR GREEN: '+c.symbol+' '+(c.dir>0?'Buy':'Sell')+' is one vote short of green on the Confluence board ('+c.forN+' for, '+c.againstN+' against; no vote yet: '+(c.missing.join(', ')||'none')+'). Not a trade call.');
  }
  lines.push(...fresh.slice(0,3));if(fresh.length>3)lines.push('NEAR GREEN: '+(fresh.length-3)+' more pairs are one vote short of green - see the Confluence board');
  return {lines,near};
}
export function confluenceGreenAlerts(rows,ctx,prevLast,prevNotified,watch,off){
  const lines=[],now=ctx.now,p=nyParts(now),last={},notified={};
  for(const [k,v] of Object.entries(prevLast||{}))if(v&&now-v.at<20*3600000)last[k]=v;
  for(const [k,t] of Object.entries(prevNotified||{}))if(now-t<36*3600000)notified[k]=t;
  if(off||p.h<3||p.h>=20||p.dow==='Sat'||p.dow==='Sun'||(p.dow==='Fri'&&p.h>=17))return {lines,last,notified};
  const cur={},fresh=[];
  for(const r of rows||[]){
    if(watch&&watch.length&&!watch.includes(r.symbol))continue;
    let c;try{c=confluenceRow(r,ctx);}catch(e){continue;}
    if(c.call!=='TRADE')continue;
    cur[c.symbol]={dir:c.dir,at:now};
    const id=c.symbol+'|'+(c.dir>0?'Buy':'Sell'),was=last[c.symbol]&&last[c.symbol].dir===c.dir;
    if(was||(notified[id]&&now-notified[id]<6*3600000))continue;
    notified[id]=now;fresh.push('CONFLUENCE GREEN: '+c.symbol+' '+(c.dir>0?'BUY':'SELL')+' ('+c.forN+' of '+c.avail+' inputs agree, '+c.againstN+' against; event risk and quarter room clear). Check the dashboard before acting. Research support, not advice.');
  }
  for(const k of Object.keys(last))if(!cur[k]&&!(rows||[]).every(r=>r.symbol!==k))delete last[k];
  Object.assign(last,cur);
  lines.push(...fresh.slice(0,3));if(fresh.length>3)lines.push('CONFLUENCE GREEN: '+(fresh.length-3)+' more pairs turned green - see the Confluence board');
  return {lines,last,notified};
}
export function weeklyOutlook(rows,calendar,evidence,now,prevDay){
  const p=nyParts(now);
  if(p.dow!=='Sun'||p.h<15||p.h>=19||prevDay===p.date)return null;
  const AST=t=>new Intl.DateTimeFormat('en-GB',{timeZone:'America/Port_of_Spain',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t))+' AST';
  const end=now+6.5*86400000,ev=[];
  if(calendar&&Array.isArray(calendar.events))for(const e of calendar.events){
    if(!/^high$/i.test(e.impact||''))continue;const t=Date.parse(e.date);if(!Number.isFinite(t)||t<now||t>end)continue;
    ev.push({t,ccy:e.country,title:e.title,cb:CENTRAL.test(e.title||'')});}
  ev.sort((a,b)=>a.t-b.t);
  const lines=['WEEK AHEAD (Trade readiness and macro bias, reference only):'];
  const cb=ev.filter(e=>e.cb).slice(0,6),dt=ev.filter(e=>!e.cb).slice(0,6);
  lines.push(cb.length?'Central bank events: '+cb.map(e=>e.ccy+' '+e.title+' '+AST(e.t)).join('; ')+'.':'Central bank events: none in the calendar.');
  lines.push(dt.length?'High-impact data: '+dt.map(e=>e.ccy+' '+e.title+' '+AST(e.t)).join('; ')+(ev.filter(e=>!e.cb).length>6?' (+'+(ev.filter(e=>!e.cb).length-6)+' more)':'')+'.':'High-impact data: none in the calendar.');
  const bull=[],bear=[];for(const r of rows||[]){if(!(r.macro&&r.macro.eligible))continue;if(r.macro.bias==='Bullish')bull.push(r.symbol);else if(r.macro.bias==='Bearish')bear.push(r.symbol);}
  lines.push('Macro bias: '+(bull.length?'Buy lean '+bull.join(', '):'no Buy lean')+'; '+(bear.length?'Sell lean '+bear.join(', '):'no Sell lean')+'.');
  const blocked={};for(const r of rows||[])if(r.macro&&!r.macro.eligible&&r.macro.gateReason)blocked[r.macro.gateReason]=(blocked[r.macro.gateReason]||0)+1;
  const bl=Object.entries(blocked);if(bl.length)lines.push('Data-blocked: '+bl.map(([k,n])=>k+' ('+n+' pairs)').join('; ')+'.');
  return {lines,day:p.date};
}
export function titleFor(lines){
  if(lines.some(l=>/^LONDON OPEN SUMMARY/.test(l)))return 'Macro ICE: London open summary';
  if(lines.some(l=>/^WEEK AHEAD/.test(l)))return 'Macro ICE: week ahead';
  if(lines.every(l=>/^CONFLUENCE GREEN:/.test(l)))return lines.length===1?'Macro ICE: Confluence GREEN':'Macro ICE: Confluence greens';
  if(lines.every(l=>/^NEAR GREEN:/.test(l)))return lines.length===1?'Macro ICE: pair one vote from green':'Macro ICE: pairs one vote from green';
  if(lines.every(l=>/^WATCH:/.test(l)))return lines.length===1?'Macro ICE: Asian range break':'Macro ICE: Asian range breaks';
  if(lines.every(l=>/^[A-Za-z ]+ is GREEN — /.test(l)))return lines.length===1?'Macro ICE: pair is GREEN':'Macro ICE: '+lines.length+' pairs are GREEN';
  const caution=lines.filter(l=>/WAIT \/ CAUTION|no longer GREEN|HEADS-UP|^OPEN /.test(l)).length;
  if(caution===lines.length)return 'Macro ICE: WAIT / CAUTION';
  if(lines.every(l=>/SIGNAL CONFIRMED/.test(l)))return lines.length===1?'Macro ICE: '+lines[0].split(' SIGNAL')[0]+' signal confirmed':'Macro ICE: '+lines.length+' signals confirmed';
  return 'Macro ICE: '+lines.length+' update'+(lines.length===1?'':'s')+(caution?' (incl. WAIT / CAUTION)':'');
}
export function marketClosed(now){
  const d=new Date(now),day=d.getUTCDay(),h=d.getUTCHours();
  return day===6||(day===5&&h>=22)||(day===0&&h<22);
}
export function message(fresh,calendar,evidence,now){
  return fresh.map(a=>{
    const k=eventRisk(a.ccys,now,24,calendar,evidence).events[0];
    const risk=k?' ⚠ '+(k.kind==='central bank'?'central bank':'release')+' '+k.ccy+' '+(k.approx?eventIn(k,now):'in '+eventIn(k,now)):'';
    return a.key+' is GREEN — '+String(a.dir||'').toUpperCase()+risk;
  });
}

const readJson=async f=>{try{return JSON.parse(await readFile(path.join(DIR,f),'utf8'));}catch{return null;}};
const readLines=async f=>{try{return (await readFile(path.join(DIR,f),'utf8')).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));}catch{return [];}};
async function get(p){
  try{const r=await fetch(BASE+p+(p.includes('?')?'&':'?')+'m='+Date.now(),{signal:AbortSignal.timeout(30000),redirect:'error'});if(!r.ok)return null;return await r.json();}catch{return null;}
}
function balloon(title,text){
  const script="Add-Type -AssemblyName System.Windows.Forms;$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(20000,$env:MACRO_ICE_TITLE,$env:MACRO_ICE_ALERT,'Info');Start-Sleep -Seconds 21;$n.Dispose()";
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script],{windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,MACRO_ICE_TITLE:title,MACRO_ICE_ALERT:text.slice(0,250)}});
  child.on('error',()=>{});child.unref();
}
function popup(title,text){
  // a small always-visible message box (balloons are hidden by Windows Do Not Disturb / Focus Assist). It is started the same way as the working test (not detached, not hidden)
  // and waited for, so Windows shows it; it closes itself after 50 seconds.
  return new Promise(resolve=>{
    const child=spawn('wscript.exe',['//Nologo',path.join(DIR,'show-popup.vbs'),title,text.replace(/\r?\n/g,' | ').slice(0,400)],{stdio:'ignore'});
    const t=setTimeout(resolve,70000);
    child.on('error',()=>{clearTimeout(t);resolve();});child.on('close',()=>{clearTimeout(t);resolve();});
  });
}
export function popupText(lines){return lines.length>3?lines.slice(0,3).join('\n')+'\n+'+(lines.length-3)+' more (full list on your phone and in the log)':lines.join('\n');}
// Batch 72: the first 40 characters of a notice line identify it; the clock-dependent tail may differ between the PC and the cloud copy
export function cloudFilter(lines,recentTexts){
  const seen=new Set();for(const t of recentTexts||[])for(const l of String(t).split('\n'))if(l.trim())seen.add(l.trim().slice(0,40));
  return lines.filter(l=>!seen.has(String(l).trim().slice(0,40)));
}
async function recentPhone(topic){
  try{const r=await fetch((process.env.ALERTS_NTFY_BASE||'https://ntfy.sh/')+encodeURIComponent(topic)+'/json?poll=1&since=6h',{signal:AbortSignal.timeout(15000)});if(!r.ok)return null;
   return (await r.text()).split('\n').filter(Boolean).map(x=>{try{const o=JSON.parse(x);return o.event==='message'?String(o.message||''):'';}catch(e){return '';}});}
  catch(e){return null;}
}
export async function phone(title,text){
  const topic=(await readLines('ntfy-topic.txt'))[0];if(!topic)return;
  if(process.env.ALERTS_CLOUD){const recent=await recentPhone(topic);if(recent){const keep=cloudFilter(text.split('\n'),recent);if(!keep.length)return;text=keep.join('\n');}}
  try{const r=await fetch((process.env.ALERTS_NTFY_BASE||'https://ntfy.sh/')+encodeURIComponent(topic),{method:'POST',body:text,headers:{Title:title,Priority:'high',Tags:'chart_with_upwards_trend'},signal:AbortSignal.timeout(15000)});return 'ntfy.sh answered '+r.status+' for topic "'+topic+'"';}
  catch(e){return 'ntfy.sh could not be reached from this PC: '+(e.cause&&e.cause.code||e.message);}
}
async function notify(lines,log){
  const title=titleFor(lines);
  const text=lines.join('\n');
  if(!process.env.ALERTS_NO_NOTIFY){const cloud=!!process.env.ALERTS_CLOUD;if(!cloud)balloon(title,text);const shown=cloud||existsSync(path.join(DIR,'alerts-no-popup.txt'))?Promise.resolve():popup(title,popupText(lines));const pr=await phone(title,text);if(pr&&log)await log('phone: '+pr);await shown;}
}

async function main(){
  const now=Number(process.env.ALERTS_NOW)||Date.now(),args=process.argv.slice(2);
  if(args.includes('--test')){
    const msg='TEST - GBPNZD is GREEN — BUY (example only)';
    const shown=popup('Macro ICE: pair is GREEN',msg);console.log('Message box shown (same code as a real alert). Click OK or wait.');
    const topic=(await readLines('ntfy-topic.txt'))[0];
    console.log(topic?await phone('Macro ICE: pair is GREEN',msg):'No ntfy-topic.txt, so no phone notice.');
    await shown;return;}
  const [di,latest]=await Promise.all([get('/api/ice/direction-intelligence?frame=1H'),get('/api/ice/latest')]);
  const log=async t=>{await mkdir(path.join(DIR,'logs'),{recursive:true});await appendFile(path.join(DIR,'logs','alerts-'+new Date(now).toISOString().slice(0,10)+'.log'),new Date(now).toISOString()+' '+t+'\n');};
  if(!di||!Array.isArray(di.rows)||!latest||!latest.analysis){await log('SKIPPED: the dashboard did not answer properly');return;}
  const greens=currentGreens(di.rows,latest.analysis.assets,latest.calendar,latest.indicatorEvidence||[],now);
  if(args.includes('--list')){
    const ev=latest.indicatorEvidence||[];
    console.log('Green right now:');
    for(const [k,g] of Object.entries(greens))console.log(' ',message([{key:k,...g}],latest.calendar,ev,now)[0]);
    if(!Object.keys(greens).length)console.log('  nothing');return;
  }
  if(marketClosed(now)){
    // Batch 67: the Sunday week-ahead notice goes out before the market opens, once per Sunday
    const prevW=await readJson('alerts-state.json');
    const wo=prevW?weeklyOutlook(di.rows,latest.calendar,latest.indicatorEvidence||[],now,prevW.weeklyDay):null;
    if(wo){const tmpW=path.join(DIR,'alerts-state.tmp');await writeFile(tmpW,JSON.stringify({...prevW,weeklyDay:wo.day},null,1));await rename(tmpW,path.join(DIR,'alerts-state.json'));await log('ALERT: '+wo.lines.join(' | '));await notify(wo.lines,log);return;}
    await log('market closed - nothing checked');return;}
  const prev=await readJson('alerts-state.json');
  const watch=await readLines('alerts-watch.txt');
  const first=!prev;
  const {fresh,notified}=newAlerts(greens,prev||{},now,watch);
  const ev=latest.indicatorEvidence||[],prevL=(prev&&prev.lights)||{};
  const lines=first?[]:message(fresh,latest.calendar,ev,now);
  const exits=first?[]:exitAlerts(prevL,greens,now,latest.calendar,ev,watch);
  const allCcy=[...new Set([...Object.keys(greens),...Object.keys(prevL)].flatMap(ccysOf))];
  const hu=first?{lines:[],keys:{}}:headsUp(allCcy,now,latest.calendar,ev,(prev&&prev.heads)||{});
  const heads={};for(const [k,v] of Object.entries({...((prev&&prev.heads)||{}),...hu.keys}))if(now-v<48*3600000)heads[k]=v;
  const np=nyParts(now),londonNow=np.h>=3&&np.h<7,nearWin=!first&&np.h>=3&&np.h<12&&!existsSync(path.join(DIR,'alerts-no-near.txt')),cgWin=!first&&np.h>=3&&np.h<20&&np.dow!=='Sat'&&np.dow!=='Sun'&&!existsSync(path.join(DIR,'alerts-no-confgreen.txt')),calWin=!first&&np.h>=3&&np.h<20&&np.dow!=='Sat'&&np.dow!=='Sun'&&!existsSync(path.join(DIR,'alerts-no-calibration.txt'));
  const research=(Object.keys(greens).length||londonNow||nearWin||cgWin||calWin)?await get('/api/ice/research'):null;
  const pt=patternAlerts(first?{}:greens,research,prev&&prev.pats,now);
  // first run: remember current pattern reads silently so they are not announced as news
  const pats=first?Object.fromEntries(Object.keys(greens).flatMap(k=>patternReads(k,research).map(r=>[r.id,now]))):pt.pats;
  const pos=first?null:await latestPositions(now);
  const pa=pos?positionAlerts(pos,di.rows,prev&&prev.against):{lines:[],against:(prev&&prev.against)||{}};
  // Batch 64: Asian-range break watch (London only) and the London-open summary; the first run records them silently
  const ab=asianBreakAlerts(research,now,prev&&prev.breaks,watch);
  const sm=first?null:londonSummary(di.rows,research,latest.calendar,ev,now,prev&&prev.summaryDay);
  // Batch 67: one phone notice per pair per day when the Confluence board shows a pair one vote short of green (London and New York morning only)
  let nr={lines:[],near:(prev&&prev.near)||{}},cg={lines:[],last:(prev&&prev.cgLast)||{},notified:(prev&&prev.cgNotified)||{}};
  // positioning (COT) is weekly data in a large download, so it is fetched at most once every 6 hours and kept in alerts-state.json
  let cotCache=(prev&&prev.cotCache)||null;
  let calAt=(prev&&prev.calAt)||0;
  if((nearWin||cgWin||calWin)&&research){
    if(!cotCache||!cotCache.map||!(now-cotCache.at<6*3600000)){const [wsEv,fred]=await Promise.all([get('/api/workspace/evidence?days=1'),get('/api/fred/saved')]);if(wsEv||fred)cotCache={at:now,map:cotMapFrom(wsEv,fred)};}
    if(cotCache&&cotCache.map){
      const cx={research,cot:cotCache.map,calendar:latest.calendar,evidence:latest.indicatorEvidence||[],now};
      // Batch 71: one Confluence reading per pair per hour goes into confluence-log.jsonl and calibration.html is refreshed (no phone notice)
      if(calWin&&!(now-calAt<55*60000)){try{await appendSnapshots(DIR,calSnapshot(di.rows,cx,now,confluenceRow));await writeReport(DIR,now);calAt=now;}catch(e){await log('calibration log failed: '+e.message);}}
      if(cgWin)cg=confluenceGreenAlerts(di.rows,cx,prev&&prev.cgLast,prev&&prev.cgNotified,watch,false);
      if(nearWin)nr=nearGreenAlerts(di.rows,cx,prev&&prev.near,watch,false);}}
  const summaryDay=first?(np.h>=3&&np.h<5?np.date:null):(sm?sm.day:(prev&&prev.summaryDay)||null);
  if(!first&&sm)lines.unshift(...sm.lines);
  lines.push(...cg.lines,...pt.lines,...(first?[]:ab.lines),...nr.lines,...exits,...hu.lines,...pa.lines);
  const lights={};for(const [k,g] of Object.entries(greens))lights[k]={dir:g.dir};
  const tmp=path.join(DIR,'alerts-state.tmp');await writeFile(tmp,JSON.stringify({lights,notified:first?{}:notified,heads,pats,against:pa&&pa.against||{},breaks:ab.breaks,summaryDay,near:nr.near,weeklyDay:(prev&&prev.weeklyDay)||null,cotCache,cgLast:cg.last,cgNotified:cg.notified,calAt,at:new Date(now).toISOString()},null,1));await rename(tmp,path.join(DIR,'alerts-state.json'));
  await log(first?'baseline saved: '+Object.keys(greens).join(', '):(lines.length?'ALERT: '+lines.join(' | '):'no new green calls')+' ['+Object.keys(greens).length+' green]');
  if(lines.length)await notify(lines,log);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
