import { readFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const corpus=JSON.parse(readFileSync('corpus.json','utf8')).filter(r=>r.nm&&r.nm.length<120);
const loc=new Map(JSON.parse(readFileSync('local_replay.json','utf8')).map(r=>[r.name,r]));
const mapped=new Set(JSON.parse(readFileSync('mapped_keys.json','utf8')).map(r=>r.ingredient_key));
const norm=s=>s.trim().toLowerCase().replace(/\s+/g,' ');   // ingredientLookupKey
function weak(name,desc){ if(!desc) return true;
  const core=extractIngredientTerms(name).core[0]; if(!core) return false;
  const stem=core.length>4?core.slice(0,core.length-1):core;
  return !desc.toLowerCase().includes(stem); }
let D={n:0},W={n:0}; const bump=(k,f)=>{D[k]=(D[k]||0)+1;W[k]=(W[k]||0)+f;};
const bad=[];
for(const c of corpus){ const f=c.c; D.n++; W.n+=f;
  if(mapped.has(norm(c.nm))){ bump('platform_mapping_saves_it',f); continue; }
  const r=loc.get(c.nm);
  if(!r||!r.source_id){ bump('no_local_hit_falls_to_edge',f); continue; }
  bump('served_by_local_substring_ranker',f);
  if(r.calories_kcal===null) bump('  -> NULL calories',f);
  if(weak(c.nm,r.description)){ bump('  -> head noun absent from pick',f); bad.push({...r,freq:f}); }
}
const pct=(o,k)=>`${o[k]||0} (${((o[k]||0)/o.n*100).toFixed(1)}%)`;
console.log(`UNMAPPED ingredients — what the local ranker actually serves\n${D.n} names / ${W.n} occurrences\n`);
console.log('bucket                              distinct            occ-weighted');
for(const k of ['platform_mapping_saves_it','served_by_local_substring_ranker','  -> NULL calories','  -> head noun absent from pick','no_local_hit_falls_to_edge'])
  console.log(k.padEnd(36), pct(D,k).padEnd(20), pct(W,k));
console.log('\nWorst unmapped substring collisions by frequency:');
bad.sort((a,b)=>b.freq-a.freq).slice(0,14).forEach(r=>console.log(`  ${String(r.freq).padStart(4)}x ${r.name.padEnd(26)} -> ${r.description}`));
