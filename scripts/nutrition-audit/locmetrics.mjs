import { readFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const corpus=JSON.parse(readFileSync('corpus.json','utf8')).filter(r=>r.nm&&r.nm.length<120);
const loc=new Map(JSON.parse(readFileSync('local_replay.json','utf8')).map(r=>[r.name,r]));
const srv=new Map(JSON.parse(readFileSync('full_replay.json','utf8')).map(r=>[r.name,r]));
function weak(name,desc){ if(!desc) return true;
  const core=extractIngredientTerms(name).core[0]; if(!core) return false;
  const stem=core.length>4?core.slice(0,core.length-1):core;
  return !desc.toLowerCase().includes(stem); }
let D={n:0},W={n:0}; const bump=(k,f)=>{D[k]=(D[k]||0)+1;W[k]=(W[k]||0)+f;};
const nulls=[];
for(const c of corpus){ const f=c.c; D.n++; W.n+=f;
  const r=loc.get(c.nm);
  if(!r||!r.source_id){ bump('no_local_hit_falls_to_edge',f); continue; }
  bump('answered_locally',f);
  if(r.calories_kcal===null){ bump('null_kcal_won',f); nulls.push(r.__proto__?{...r,freq:f}:{...r,freq:f}); }
  if(weak(c.nm,r.description)) bump('weak_head_noun',f);
  if(r.data_type==='Foundation') bump('tier_Foundation',f);
}
const pct=(o,k)=>`${o[k]||0} (${((o[k]||0)/o.n*100).toFixed(1)}%)`;
console.log(`LOCAL PATH (what production actually serves first)  ${D.n} names / ${W.n} occurrences\n`);
console.log('metric                        distinct            occurrence-weighted');
for(const k of ['answered_locally','no_local_hit_falls_to_edge','null_kcal_won','weak_head_noun','tier_Foundation'])
  console.log(k.padEnd(28), pct(D,k).padEnd(20), pct(W,k));
console.log('\nTOP null-calorie winners on the LOCAL path:');
nulls.sort((a,b)=>b.freq-a.freq).slice(0,10).forEach(r=>console.log(`  ${String(r.freq).padStart(4)}x ${r.name} -> [${r.data_type}] ${r.description}`));
// disagreement between the two rankers
let dis=0,disW=0;
for(const c of corpus){ const l=loc.get(c.nm), s=srv.get(c.nm);
  if(l&&s&&l.source_id&&s.source_id&&l.source_id!==s.source_id){dis++;disW+=c.c;} }
console.log(`\nLOCAL vs SERVER ranker pick the SAME food: ${((1-dis/corpus.length)*100).toFixed(1)}% of names`);
console.log(`They DISAGREE on ${dis} names (${(disW/W.n*100).toFixed(1)}% of occurrences).`);
