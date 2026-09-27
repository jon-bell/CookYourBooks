import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const ds=new Map(JSON.parse(readFileSync('audit_dataset.json','utf8')).map(r=>[r.idx,r]));
const mapped=new Map(JSON.parse(readFileSync('gt.json','utf8')).map(r=>[r.ingredient_key,String(r.source_id)]));
const md=new Map(JSON.parse(readFileSync('mapped_desc.json','utf8')).map(r=>[String(r.source_id),r]));
const norm=s=>s.trim().toLowerCase().replace(/\s+/g,' ');
const H=new Map();
for(const r of JSON.parse(readFileSync('new_sample.json','utf8'))){ if(!r.source_id) continue;
  if(!H.has(r.idx))H.set(r.idx,[]); H.get(r.idx).push(r); }
const out=[];
for(const [i,d] of ds){
  const {compound}=extractIngredientTerms(d.name);
  const mk=mapped.get(norm(d.name));
  let pick,path;
  const m = mk ? md.get(mk) : null;
  // A mapped row with no calories is now dropped and re-searched
  // (useRecipeNutrition), so model that here too.
  if(m && m.calories_kcal !== null){ path='platform_mapping'; pick={source_id:mk,description:m.description,data_type:m.data_type,calories_kcal:m.calories_kcal}; }
  else if(compound){ path='declined_compound'; pick=null; }
  else { const h=H.get(i)||[]; path=h.length?'local_ranker':'falls_through_to_edge'; pick=h[0]??null; }
  out.push({idx:i,name:d.name,freq:d.freq,stratum:d.stratum,path,pick,top5:H.get(i)||[]});
}
writeFileSync('new_dataset.json',JSON.stringify(out,null,1));
for(let p=0;p<6;p++){ let s='';
  for(const r of out.slice(p*50,(p+1)*50)){
    s+=`\n### [${r.idx}] "${r.name}"  (freq=${r.freq}, stratum=${r.stratum})\n`;
    s+=`match path : ${r.path}\n`;
    s+=`AUTO-MATCH : ${r.pick?`[${r.pick.source_id}] ${r.pick.description}  (${r.pick.data_type}, ${r.pick.calories_kcal===null?'NO CALORIE DATA':r.pick.calories_kcal+' kcal/100g'})`:(r.path==='declined_compound'?'NONE — string names two foods, matcher declines on purpose':'NONE — no local candidate; falls through to the server')}\n`;
    s+=`other local candidates:\n`;
    const rest=r.top5.slice(1);
    if(!rest.length) s+='  (none)\n';
    for(const h of rest) s+=`  ${h.rn}. [${h.source_id}] ${h.description} (${h.data_type}, ${h.calories_kcal===null?'NO CALORIES':h.calories_kcal+' kcal'})\n`;
  }
  writeFileSync(`newpacket_${p}.md`,s);
}
const c={}; for(const r of out) c[r.path]=(c[r.path]||0)+1;
console.log('paths:',JSON.stringify(c));
