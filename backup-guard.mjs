// Decides whether the cloud backup should collect. It runs ONLY when the main PC collector has clearly not delivered:
//   weekday (UTC Mon-Fri): data older than 13 hours      weekend: data older than 60 hours
// Anything else (including a site that does not answer) = do nothing. Set FORCE=true to test the full path once.
import {appendFileSync} from 'node:fs';
const base=(process.env.MACRO_ICE_BASE||'').replace(/\/$/,'');
const out=(run,why)=>{console.log((run?'RUN: ':'SKIP: ')+why);if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'run='+run+'\n');};
if(!/^(https:\/\/|http:\/\/127\.0\.0\.1)/.test(base)){console.log('MACRO_ICE_BASE is not set to a site address');process.exit(1);}
if(process.env.FORCE==='true'){out(true,'forced test run');process.exit(0);}
let h;
try{const r=await fetch(base+'/api/ice/health?t='+Date.now(),{signal:AbortSignal.timeout(30000),redirect:'error'});if(!r.ok)throw Error('HTTP '+r.status);h=await r.json();}
catch(e){out(false,'site health unreadable ('+e.message+') - collecting would not help');process.exit(0);}
const age=h.ageHours==null?NaN:Number(h.ageHours),day=new Date().getUTCDay(),weekend=day===0||day===6,limit=weekend?60:13;
if(!Number.isFinite(age))out(true,'no successful collection is recorded');
else if(age>limit)out(true,'data is '+age.toFixed(1)+'h old (limit '+limit+'h)');
else out(false,'main collector is healthy: data is '+age.toFixed(1)+'h old (limit '+limit+'h)');
