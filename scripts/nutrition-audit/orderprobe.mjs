// Score candidate ORDER BY variants against the 78 hand-curated mappings.
import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const gt=JSON.parse(readFileSync('gt.json','utf8'));
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
const arr=a=>'ARRAY['+a.map(esc).join(',')+']::text[]';
const BLOB=`with blob as materialized (
  select f.source_id,f.description,f.data_type,f.calories_kcal,
    ' '||regexp_replace(lower(translate(f.description||' '||coalesce(f.brand,'')||' '||coalesce(f.brand_owner,''),
    'áàâäãåéèêëíìîïóòôöõúùûüñç','aaaaaaeeeeiiiiooooouuuunc')),'[^a-z0-9]+',' ','g')||' ' as b
  from nutrition_foods_master f
  where f.data_type in ('Foundation','SR Legacy','Survey (FNDDS)') and f.calories_kcal is not null)`;
const RATIO=`((select count(*) from unnest(q.terms) t where b.b like '% '||t||' %')*1.0/greatest(length(b.b)-length(replace(b.b,' ',''))-1,1))`;
const COV=`(select count(*) from unnest(q.terms) t where b.b like '% '||t||' %')`;
const PCOV=`(select count(*) from unnest(q.terms) t where b.b like '% '||t||'%')`;
const HAS=`(case when q.head<>'' and b.b like '% '||q.head||' %' then 1 else 0 end)`;
const PFX=`(case when q.head<>'' and b.b like ' '||q.head||'%' then 1 else 0 end)`;
const PFX2=`(case when q.head<>'' and (b.b like ' '||q.head||'%' or b.b like '% '||q.head||'%' and position(',' in b.description)>0 and lower(btrim(split_part(b.description,',',2))) like q.head||'%') then 1 else 0 end)`;
const TAIL=`length(b.description) asc, case b.data_type when 'Foundation' then 0 when 'SR Legacy' then 1 when 'Survey (FNDDS)' then 2 else 9 end asc, b.description asc`;
const VARIANTS={
  A_has_pfx_ratio:   `${HAS} desc, ${PFX} desc, ${RATIO} desc, ${COV} desc, ${PCOV} desc, ${TAIL}`,
  B_has_ratio_pfx:   `${HAS} desc, ${RATIO} desc, ${PFX} desc, ${COV} desc, ${PCOV} desc, ${TAIL}`,
  C_has_pfx2_ratio:  `${HAS} desc, ${PFX2} desc, ${RATIO} desc, ${COV} desc, ${PCOV} desc, ${TAIL}`,
  D_has_cov_pfx:     `${HAS} desc, ${COV} desc, ${PFX} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`,
  E_has_pfx2_cov:    `${HAS} desc, ${PFX2} desc, ${COV} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`,
  F_has_cov_pfx2:    `${HAS} desc, ${COV} desc, ${PFX2} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`,
  G_has_ratcov_pfx2: `${HAS} desc, (${RATIO}+${COV}*0.25) desc, ${PFX2} desc, ${PCOV} desc, ${TAIL}`,
};
const TOK='greatest(length(b.b)-length(replace(b.b,\' \',\'\'))-1,1)';
for (const w of [0.15,0.2,0.25,0.3,0.4]) {
  VARIANTS[`H_pen${String(w).replace('.','')}_pfx`]  = `${HAS} desc, (${COV} - ${w}*${TOK}) desc, ${PFX} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`;
  VARIANTS[`I_pen${String(w).replace('.','')}_pfx2`] = `${HAS} desc, (${COV} - ${w}*${TOK}) desc, ${PFX2} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`;
}
const vals=gt.map(r=>{const {terms,core,compound}=extractIngredientTerms(r.ingredient_key);
  return `(${esc(r.ingredient_key)},${esc(String(r.source_id))},${arr(compound?[]:terms)},${esc(core[0]??'')})`;}).join(',');
for(const [name,ord] of Object.entries(VARIANTS)){
  writeFileSync(`ord_${name}.sql`, `${BLOB},
q(k,truth,terms,head) as (values ${vals})
select q.k,q.truth,s.source_id pick,s.description
from q left join lateral (select b.source_id,b.description from blob b
  where cardinality(q.terms)>0 and exists(select 1 from unnest(q.terms) t where b.b like '% '||t||'%')
  order by ${ord} limit 1) s on true`);
}
console.log(Object.keys(VARIANTS).join(' '));
