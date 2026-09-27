import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const corpus = JSON.parse(readFileSync('corpus.json','utf8')).filter(r=>r.nm && r.nm.length<120);
const esc = s => "'" + String(s).replace(/'/g,"''") + "'";
mkdirSync('full', {recursive:true});
const CH=300; let n=0;
for(let i=0;i<corpus.length;i+=CH){
  const vals = corpus.slice(i,i+CH).map(r=>{
    const t=extractIngredientTerms(r.nm);
    return `(${esc(r.nm)},${r.c},${esc(t.normalized)},${esc(t.core[0]??'')})`;
  }).join(',');
  writeFileSync(`full/b_${n}.sql`, `
with q(name,freq,query,head) as (values ${vals})
select q.name,q.freq,q.query,q.head,
       s.source_id,s.description,s.data_type,s.calories_kcal,
       (s.portions is null or jsonb_array_length(s.portions)=0) as no_portions
from q left join lateral (
  select * from public.search_nutrition_foods(q.query,1,true)
) s on true`);
  n++;
}
console.log('corpus',corpus.length,'batches',n);
