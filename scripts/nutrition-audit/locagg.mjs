import { readFileSync, writeFileSync } from 'node:fs';
const ld=new Map(JSON.parse(readFileSync('local_dataset.json','utf8')).map(r=>[r.idx,r]));
let A=[]; for(let i=0;i<6;i++) A.push(...JSON.parse(readFileSync(`locgraded_${i}.json`,'utf8')));
A=A.map(g=>{const d=ld.get(g.idx);return{...g,freq:d.freq,stratum:d.stratum,path:d.path,name:d.name};});
writeFileSync('locgraded_all.json',JSON.stringify(A,null,1));
const V=['CORRECT','ACCEPTABLE','WRONG_VARIANT','WRONG_FOOD','UNUSABLE'];
const ok=v=>v==='CORRECT'||v==='ACCEPTABLE';
function tab(rows,label){ const c={};let wn=0,wg=0;
  for(const r of rows){c[r.verdict]=(c[r.verdict]||0)+1;wn+=r.freq;if(ok(r.verdict))wg+=r.freq;}
  const g=rows.filter(r=>ok(r.verdict)).length;
  console.log(`${label.padEnd(32)} usable ${String(g).padStart(3)}/${String(rows.length).padEnd(3)} (${(g/rows.length*100).toFixed(1).padStart(5)}%)  occ-wtd ${(wg/wn*100).toFixed(1).padStart(5)}%  [${V.map(v=>v.slice(0,4)+':'+(c[v]||0)).join(' ')}]`);}
tab(A,'ALL 300 (true production)');
tab(A.filter(r=>r.stratum==='head'),'  head (common names)');
tab(A.filter(r=>r.stratum==='tail'),'  tail');
console.log();
for(const p of ['platform_mapping','local_substring_ranker','falls_through_to_edge']) tab(A.filter(r=>r.path===p),'  path='+p);
const fm={}; for(const r of A) if(r.failure_mode) fm[r.failure_mode]=(fm[r.failure_mode]||0)+1;
console.log('\nfailure modes:'); Object.entries(fm).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
const nc=A.filter(r=>!ok(r.verdict)); const fix=nc.filter(r=>r.better_in_top5);
console.log(`\nOf ${nc.length} bad matches, ${fix.length} (${(fix.length/nc.length*100).toFixed(0)}%) had a better row already in the local candidate list.`);
