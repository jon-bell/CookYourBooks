import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const ds=JSON.parse(readFileSync('audit_dataset.json','utf8'));
const mapped=new Map(JSON.parse(readFileSync('gt.json','utf8')).map(r=>[r.ingredient_key,r.source_id]));
const md=new Map(JSON.parse(readFileSync('mapped_desc.json','utf8')).map(r=>[String(r.source_id),r]));
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
// build a top-5 local-ranker query for the 300 sample
const parts=ds.map(d=>{
  const {terms}=extractIngredientTerms(d.name);
  if(!terms.length) return null;
  const blob=`lower(f.description||' '||coalesce(f.brand,'')||' '||coalesce(f.brand_owner,''))`;
  const orW=terms.map(t=>`${blob} like ${esc('%'+t+'%')}`).join(' or ');
  const cov=terms.map(t=>`(${blob} like ${esc('%'+t+'%')})::int`).join(' + ');
  return `select ${d.idx} idx, s.* from (select f.source_id, f.description, f.data_type, f.calories_kcal,
      row_number() over () rn
    from nutrition_foods_master f
    where f.data_type in ('Foundation','SR Legacy') and (${orW})
    order by case f.data_type when 'Foundation' then 0 when 'SR Legacy' then 1 else 9 end asc,
             case when f.calories_kcal is null then 1 else 0 end asc,
             (${cov}) desc, length(f.description) asc, f.description asc
    limit 5) s`;
}).filter(Boolean);
for(let i=0;i<parts.length;i+=30)
  writeFileSync(`lp_${i/30|0}.sql`, parts.slice(i,i+30).join('\nunion all\n')+'\norder by idx, rn');
console.log('batches',Math.ceil(parts.length/30));
