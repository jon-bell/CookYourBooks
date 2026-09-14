import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const corpus = JSON.parse(readFileSync('corpus.json','utf8')).filter(r=>r.nm&&r.nm.length<120);
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
mkdirSync('loc',{recursive:true});
const CH=120; let n=0;
for(let i=0;i<corpus.length;i+=CH){
  const parts=corpus.slice(i,i+CH).map(r=>{
    const {terms}=extractIngredientTerms(r.nm);
    if(terms.length===0) return `select ${esc(r.nm)} name, ${r.c} freq, null::text source_id, null::text description, null::text data_type, null::numeric calories_kcal`;
    // replicate searchLocalEssentials: OR of LIKE %term%, coverage sum, tier FIRST
    const blob=`lower(f.description||' '||coalesce(f.brand,'')||' '||coalesce(f.brand_owner,''))`;
    const orW=terms.map(t=>`${blob} like ${esc('%'+t+'%')}`).join(' or ');
    const cov=terms.map(t=>`(${blob} like ${esc('%'+t+'%')})::int`).join(' + ');
    return `select ${esc(r.nm)} name, ${r.c} freq, s.source_id, s.description, s.data_type, s.calories_kcal
      from (select f.source_id, f.description, f.data_type, f.calories_kcal
            from nutrition_foods_master f
            where f.data_type in ('Foundation','SR Legacy') and (${orW})
            order by case f.data_type when 'Foundation' then 0 when 'SR Legacy' then 1 else 9 end asc,
                     case when f.calories_kcal is null then 1 else 0 end asc,
                     (${cov}) desc, length(f.description) asc, f.description asc
            limit 1) s`;
  });
  writeFileSync(`loc/b_${n}.sql`, parts.join('\nunion all\n')); n++;
}
console.log('batches',n);
