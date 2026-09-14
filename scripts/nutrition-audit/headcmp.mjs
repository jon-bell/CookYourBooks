import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
import { BLOBCTE, ORD } from './sqlfrag.mjs';
const corpus=JSON.parse(readFileSync('corpus.json','utf8')).sort((a,b)=>b.c-a.c).slice(0,40);
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
const arr=a=>'ARRAY['+a.map(esc).join(',')+']::text[]';
const vals=corpus.map(r=>{const {terms,core,compound}=extractIngredientTerms(r.nm);
  return `(${esc(r.nm)},${r.c},${arr(compound?[]:terms)},${esc(core[0]??'')})`;}).join(',');
for(const [n,ord] of Object.entries(ORD))
  writeFileSync(`hc_${n}.sql`, `${BLOBCTE},
q(name,freq,terms,head) as (values ${vals})
select q.name,q.freq,s.description from q left join lateral (
  select b.description from blob b where cardinality(q.terms)>0
    and exists(select 1 from unnest(q.terms) t where b.b like '% '||t||'%')
  order by ${ord} limit 1) s on true order by q.freq desc`);
