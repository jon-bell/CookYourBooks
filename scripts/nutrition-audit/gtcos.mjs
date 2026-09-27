import { readFileSync, writeFileSync } from 'node:fs';
const gt=JSON.parse(readFileSync('gt.json','utf8'));
const vs=JSON.parse(readFileSync('gt_vecs.json','utf8'));
const esc=s=>"'"+String(s).replace(/'/g,"''")+"'";
const parts=gt.map((r,i)=>{
  const v='['+vs[i].join(',')+']';
  return `select ${esc(r.ingredient_key)} k, ${esc(r.source_id)} truth, s.source_id sem, s.cos
    from (select m.source_id, round((1-(e.embedding <=> '${v}'::vector(384)))::numeric,4) cos
          from nutrition_food_embeddings e join nutrition_foods_master m
            on m.source=e.source and m.source_id=e.source_id
          order by e.embedding <=> '${v}'::vector(384) limit 1) s`;
});
for(let i=0;i<parts.length;i+=20) writeFileSync(`gc_${i/20|0}.sql`, parts.slice(i,i+20).join('\nunion all\n'));
