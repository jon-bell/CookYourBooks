// Replay the NEW searchLocalEssentials (post-overhaul) against prod.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
import { BLOBCTE, ORD } from './sqlfrag.mjs';
const corpus = JSON.parse(readFileSync('corpus.json','utf8')).filter(r=>r.nm&&r.nm.length<120);
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
const arr=a=>'ARRAY['+a.map(esc).join(',')+']::text[]';
mkdirSync('nloc',{recursive:true});
const CH=300; let n=0;
for(let i=0;i<corpus.length;i+=CH){
  const vals=corpus.slice(i,i+CH).map(r=>{
    const {terms,core,compound}=extractIngredientTerms(r.nm);
    return `(${esc(r.nm)},${r.c},${arr(compound?[]:terms)},${esc(core[0]??'')})`;
  }).join(',');
  writeFileSync(`nloc/b_${n}.sql`, `${BLOBCTE},
q(name,freq,terms,head) as (values ${vals})
select q.name, q.freq, s.source_id, s.description, s.data_type, s.calories_kcal
from q left join lateral (
  select b.source_id,b.description,b.data_type,b.calories_kcal
  from blob b
  where cardinality(q.terms) > 0
    and exists (select 1 from unnest(q.terms) t where b.b like '% '||t||'%')
  order by ${ORD.H} limit 1) s on true`); n++;
}
console.log('batches',n);
