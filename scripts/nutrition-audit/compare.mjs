import { readFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const corpus=JSON.parse(readFileSync('corpus.json','utf8')).filter(r=>r.nm&&r.nm.length<120);
const OLD=new Map(JSON.parse(readFileSync('local_replay.json','utf8')).map(r=>[r.name,r]));
const NEW=new Map(JSON.parse(readFileSync('new_local_replay.json','utf8')).map(r=>[r.name,r]));
const mapped=new Set(JSON.parse(readFileSync('mapped_keys.json','utf8')).map(r=>r.ingredient_key));
const norm=s=>s.trim().toLowerCase().replace(/\s+/g,' ');
function weak(name,desc){ if(!desc) return true;
  const core=extractIngredientTerms(name).core[0]; if(!core) return false;
  const stem=core.length>4?core.slice(0,core.length-1):core;
  return !desc.toLowerCase().includes(stem); }
function score(M,label){
  let D={n:0},W={n:0}; const bump=(k,f)=>{D[k]=(D[k]||0)+1;W[k]=(W[k]||0)+f;};
  for(const c of corpus){ const f=c.c; D.n++; W.n+=f;
    if(mapped.has(norm(c.nm))){ bump('mapping',f); continue; }
    const r=M.get(c.nm);
    if(!r||!r.source_id){ bump('no_hit',f); continue; }
    bump('answered',f);
    if(r.calories_kcal===null) bump('null_kcal',f);
    if(weak(c.nm,r.description)) bump('head_absent',f);
  }
  const p=(o,k)=>((o[k]||0)/o.n*100).toFixed(1)+'%';
  console.log(`${label.padEnd(12)} answered=${p(W,'answered')}  head_absent=${p(W,'head_absent')}  null_kcal=${p(W,'null_kcal')}  no_hit=${p(W,'no_hit')}   (occurrence-weighted)`);
  return W;
}
console.log('Full corpus, unmapped ingredients (the 28.6% covered by the curated table is excluded from the rates):\n');
score(OLD,'BEFORE'); score(NEW,'AFTER');
// what changed
let changed=0, changedW=0;
for(const c of corpus){ const o=OLD.get(c.nm), n=NEW.get(c.nm);
  if((o?.source_id??null)!==(n?.source_id??null)){changed++;changedW+=c.c;} }
console.log(`\npick changed on ${changed} names (${(changedW/corpus.reduce((a,r)=>a+r.c,0)*100).toFixed(1)}% of occurrences)`);
console.log('\nSpot-check of the audit’s worst offenders:');
for(const nm of ['ground black pepper','diamond crystal kosher salt','ground turmeric','honey','fresh ginger','white sugar','pure vanilla extract','bay leaves','butter','unsalted butter','fresh cilantro','water','kosher salt','extra virgin olive oil','jalapeño','crème fraîche','strained lime juice','cherry tomatoes']){
  const o=OLD.get(nm), n=NEW.get(nm);
  if(!o&&!n) continue;
  console.log(`  ${nm}\n      was: ${o?.description??'(none)'}\n      now: ${n?.description??'(none)'}`);
}
