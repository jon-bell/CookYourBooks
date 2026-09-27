// Shared SQL fragments so every replay scores the same algorithm the app runs.
export const BLOBCTE = `with blob as materialized (
  select f.source_id,f.description,f.data_type,f.calories_kcal,
    ' '||regexp_replace(lower(translate(f.description||' '||coalesce(f.brand,'')||' '||coalesce(f.brand_owner,''),
    'áàâäãåéèêëíìîïóòôöõúùûüñç','aaaaaaeeeeiiiiooooouuuunc')),'[^a-z0-9]+',' ','g')||' ' as b
  from nutrition_foods_master f
  where f.data_type in ('Foundation','SR Legacy','Survey (FNDDS)') and f.calories_kcal is not null)`;
// whole-word probe tolerating regular plurals, mirroring variantsOf() in localCache.ts
export const WW = (e) => `(b.b like '% '||${e}||' %' or b.b like '% '||${e}||'s %' or b.b like '% '||${e}||'es %'
  or (length(${e})>3 and right(${e},2)='es' and b.b like '% '||left(${e},length(${e})-2)||' %')
  or (length(${e})>2 and right(${e},1)='s' and b.b like '% '||left(${e},length(${e})-1)||' %'))`;
export const COV  = `(select count(*) from unnest(q.terms) t where ${WW('t')})`;
export const PCOV = `(select count(*) from unnest(q.terms) t where b.b like '% '||t||'%')`;
export const TOK  = `greatest(length(b.b)-length(replace(b.b,' ',''))-1,1)`;
export const RATIO= `(${COV}*1.0/${TOK})`;
export const HAS  = `(case when q.head<>'' and ${WW('q.head')} then 1 else 0 end)`;
export const PFX  = `(case when q.head<>'' and b.b like ' '||q.head||'%' then 1 else 0 end)`;
export const TAIL = `length(b.description) asc, case b.data_type when 'Foundation' then 0 when 'SR Legacy' then 1 when 'Survey (FNDDS)' then 2 else 9 end asc, b.description asc`;
export const ORD = {
  D: `${HAS} desc, ${COV} desc, ${PFX} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`,
  H: `${HAS} desc, (${COV} - 0.25*${TOK}) desc, ${PFX} desc, ${RATIO} desc, ${PCOV} desc, ${TAIL}`,
  P: `${HAS} desc, ${PFX} desc, ${RATIO} desc, ${COV} desc, ${PCOV} desc, ${TAIL}`,
};
