import { readFileSync, writeFileSync } from 'node:fs';
const ds = JSON.parse(readFileSync('audit_dataset.json','utf8'));
const meta = new Map(ds.map(r=>[r.idx,r]));
let all=[];
for(let i=0;i<6;i++) all.push(...JSON.parse(readFileSync(`graded_${i}.json`,'utf8')));
all = all.map(g=>({...g, ...(()=>{const m=meta.get(g.idx); return {stratum:m.stratum, freq:m.freq, path:m.path, name:m.name};})()}));
writeFileSync('graded_all.json', JSON.stringify(all,null,1));
const V=['CORRECT','ACCEPTABLE','WRONG_VARIANT','WRONG_FOOD','UNUSABLE'];
function tab(rows,label){
  const c={},n=rows.length; let wn=0,wc={};
  for(const r of rows){ c[r.verdict]=(c[r.verdict]||0)+1; wn+=r.freq; wc[r.verdict]=(wc[r.verdict]||0)+r.freq; }
  console.log(`\n--- ${label} (n=${n}, occurrences=${wn}) ---`);
  for(const v of V) console.log(`  ${v.padEnd(14)} ${String(c[v]||0).padStart(3)} (${((c[v]||0)/n*100).toFixed(1).padStart(5)}%)   occ-weighted ${((wc[v]||0)/wn*100).toFixed(1)}%`);
  const good=(c.CORRECT||0)+(c.ACCEPTABLE||0), wgood=(wc.CORRECT||0)+(wc.ACCEPTABLE||0);
  console.log(`  => USABLE      ${good} (${(good/n*100).toFixed(1)}%)   occ-weighted ${(wgood/wn*100).toFixed(1)}%`);
}
tab(all,'ALL 300');
tab(all.filter(r=>r.stratum==='head'),'HEAD (150 most common names)');
tab(all.filter(r=>r.stratum==='tail'),'TAIL (random long-tail names)');
for(const p of ['platform_mapping','lexical','semantic_fallback']) tab(all.filter(r=>r.path===p), `path=${p}`);
const fm={};
for(const r of all) if(r.failure_mode) fm[r.failure_mode]=(fm[r.failure_mode]||0)+1;
console.log('\n--- failure modes ---');
Object.entries(fm).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
const rank = all.filter(r=>r.better_in_top5);
console.log(`\nRANKING failures (better candidate WAS in top-5): ${rank.length} of ${all.filter(r=>r.verdict!=='CORRECT').length} non-correct`);
