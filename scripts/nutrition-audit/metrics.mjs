import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const rows = JSON.parse(readFileSync('full_replay.json','utf8'));
function weak(name, desc){
  if(!desc) return true;
  const core = extractIngredientTerms(name).core[0];
  if(!core) return false;
  const stem = core.length>4?core.slice(0,core.length-1):core;
  return !desc.toLowerCase().includes(stem);
}
let D={n:0}, W={n:0};
const bump=(k,f)=>{D[k]=(D[k]||0)+1; W[k]=(W[k]||0)+f;};
const bad=[];
for(const r of rows){
  const f=r.freq; D.n++; W.n+=f;
  if(!r.source_id){ bump('no_hit',f); bad.push(['no_hit',r]); continue; }
  if(r.calories_kcal===null){ bump('null_kcal_won',f); bad.push(['null_kcal',r]); }
  if(weak(r.name,r.description)) { bump('lexical_weak',f); bad.push(['weak',r]); }
  if(r.no_portions) bump('no_portions',f);
  if(r.data_type==='Foundation') bump('tier_foundation',f);
}
const pct=(o,k)=>`${o[k]||0} (${((o[k]||0)/o.n*100).toFixed(1)}%)`;
console.log(`CORPUS: ${D.n} distinct names, ${W.n} occurrences\n`);
console.log('metric                  distinct-names        occurrence-weighted');
for(const k of ['no_hit','null_kcal_won','lexical_weak','no_portions','tier_foundation'])
  console.log(k.padEnd(22), pct(D,k).padEnd(21), pct(W,k));
writeFileSync('full_bad.json', JSON.stringify(bad,null,1));
