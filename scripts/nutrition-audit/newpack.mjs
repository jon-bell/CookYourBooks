import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
import { BLOBCTE, ORD } from './sqlfrag.mjs';
const ds=JSON.parse(readFileSync('audit_dataset.json','utf8'));
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
const arr=a=>'ARRAY['+a.map(esc).join(',')+']::text[]';
const vals=ds.map(d=>{const {terms,core,compound}=extractIngredientTerms(d.name);
  return `(${d.idx},${esc(d.name)},${arr(compound?[]:terms)},${esc(core[0]??'')})`;}).join(',');
for(let i=0;i<5;i++){
  const chunk=ds.slice(i*60,(i+1)*60).map(d=>{const {terms,core,compound}=extractIngredientTerms(d.name);
    return `(${d.idx},${esc(d.name)},${arr(compound?[]:terms)},${esc(core[0]??'')})`;}).join(',');
  writeFileSync(`np_${i}.sql`, `${BLOBCTE},
q(idx,name,terms,head) as (values ${chunk})
select q.idx, row_number() over (partition by q.idx) rn,
       s.source_id, s.description, s.data_type, s.calories_kcal
from q left join lateral (
  select b.source_id,b.description,b.data_type,b.calories_kcal
  from blob b
  where cardinality(q.terms) > 0
    and exists (select 1 from unnest(q.terms) t where b.b like '% '||t||'%')
  order by ${ORD.H} limit 5) s on true`);
}
console.log('5 batches');
