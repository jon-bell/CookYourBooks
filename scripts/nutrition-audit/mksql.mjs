import { readFileSync, writeFileSync } from 'node:fs';
const sample = JSON.parse(readFileSync('sample.json','utf8'));
const esc = s => "'" + String(s).replace(/'/g,"''") + "'";
const CH = Number(process.argv[2]||50);
let n=0;
for (let i=0;i<sample.length;i+=CH){
  const chunk = sample.slice(i,i+CH);
  const vals = chunk.map(r=>`(${r.idx},${esc(r.name)},${esc(r.query)})`).join(',\n    ');
  const sql = `
with q(idx,name,query) as (values
    ${vals}
)
select q.idx, q.name, q.query,
       m.source_id as mapped_source_id,
       coalesce(jsonb_agg(jsonb_build_object(
         'rank', s.rn, 'source_id', s.source_id, 'desc', s.description,
         'data_type', s.data_type, 'kcal', s.calories_kcal
       ) order by s.rn) filter (where s.source_id is not null), '[]'::jsonb) as hits
from q
left join ingredient_nutrition_mappings m
       on m.owner_id is null and m.ingredient_key = q.name
left join lateral (
  select f.source_id, f.description, f.data_type, f.calories_kcal,
         row_number() over () rn
  from public.search_nutrition_foods(q.query, 5, true) f
) s on true
group by q.idx, q.name, q.query, m.source_id
order by q.idx`;
  writeFileSync(`batch_${n}.sql`, sql); n++;
}
console.log('batches:',n);
