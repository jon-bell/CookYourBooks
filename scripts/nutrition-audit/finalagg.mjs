import { readFileSync, writeFileSync } from 'node:fs';
const nd=new Map(JSON.parse(readFileSync('new_dataset.json','utf8')).map(r=>[r.idx,r]));
const od=new Map(JSON.parse(readFileSync('locgraded_all.json','utf8')).map(r=>[r.idx,r]));
let A=[]; for(let i=0;i<6;i++) A.push(...JSON.parse(readFileSync(`newgraded_${i}.json`,'utf8')));
A=A.map(g=>{const d=nd.get(g.idx);return{...g,freq:d.freq,stratum:d.stratum,path:d.path,name:d.name};});
writeFileSync('newgraded_all.json',JSON.stringify(A,null,1));
const ok=v=>v==='CORRECT'||v==='ACCEPTABLE';
const V=['CORRECT','ACCEPTABLE','WRONG_VARIANT','WRONG_FOOD','UNUSABLE'];
function row(rows,label){ const c={};let wn=0,wg=0;
  for(const r of rows){c[r.verdict]=(c[r.verdict]||0)+1;wn+=r.freq;if(ok(r.verdict))wg+=r.freq;}
  const g=rows.filter(r=>ok(r.verdict)).length;
  return {label,n:rows.length,usable:g,pct:g/rows.length*100,wpct:wn?wg/wn*100:0,c};}
function show(r){console.log(`${r.label.padEnd(30)} ${String(r.usable).padStart(3)}/${String(r.n).padEnd(3)} ${r.pct.toFixed(1).padStart(5)}%   occ-wtd ${r.wpct.toFixed(1).padStart(5)}%   [${V.map(v=>v.slice(0,4)+':'+(r.c[v]||0)).join(' ')}]`);}
const oldAll=[...od.values()];
console.log('=== BEFORE (audited production path) ===');
show(row(oldAll,'all 300'));
show(row(oldAll.filter(r=>r.stratum==='head'),'  head'));
show(row(oldAll.filter(r=>r.stratum==='tail'),'  tail'));
console.log('\n=== AFTER (this branch) ===');
show(row(A,'all 300'));
show(row(A.filter(r=>r.stratum==='head'),'  head'));
show(row(A.filter(r=>r.stratum==='tail'),'  tail'));
console.log('\nby path:');
for(const p of ['platform_mapping','local_ranker','falls_through_to_edge','declined_compound'])
  { const rs=A.filter(r=>r.path===p); if(rs.length) show(row(rs,'  '+p)); }
const b=row(oldAll,'b'), a=row(A,'a');
console.log(`\nDELTA: ${b.pct.toFixed(1)}% -> ${a.pct.toFixed(1)}% by name   |   ${b.wpct.toFixed(1)}% -> ${a.wpct.toFixed(1)}% occurrence-weighted`);
const fm={}; for(const r of A) if(r.failure_mode) fm[r.failure_mode]=(fm[r.failure_mode]||0)+1;
console.log('\nremaining failure modes:');
Object.entries(fm).sort((x,y)=>y[1]-x[1]).slice(0,8).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
// regressions
const regr=A.filter(r=>ok(od.get(r.idx).verdict)&&!ok(r.verdict));
const impr=A.filter(r=>!ok(od.get(r.idx).verdict)&&ok(r.verdict));
console.log(`\nimproved: ${impr.length} items (${impr.reduce((s,r)=>s+r.freq,0)} occurrences)`);
console.log(`regressed: ${regr.length} items (${regr.reduce((s,r)=>s+r.freq,0)} occurrences)`);
regr.sort((x,y)=>y.freq-x.freq).slice(0,8).forEach(r=>console.log(`   ${String(r.freq).padStart(4)}x ${r.name} — ${r.verdict}/${r.failure_mode??''}`));
