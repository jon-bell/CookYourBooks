import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const ds = JSON.parse(readFileSync('audit_dataset.json','utf8'));
const which = process.argv[2];           // clean | raw
const vecs = JSON.parse(readFileSync(`v_${which}.json`,'utf8'));
mkdirSync(`sem_${which}`, {recursive:true});
const CH=25; let n=0;
for(let i=0;i<ds.length;i+=CH){
  const parts = ds.slice(i,i+CH).map((r,j)=>{
    const v = '[' + vecs[i+j].join(',') + ']';
    return `select ${r.idx} idx, s.rn, s.source_id, s.description, s.data_type, s.calories_kcal,
      round((1-(s.d))::numeric,4) cosine
      from (select m.source_id, m.description, m.data_type, m.calories_kcal,
              (e.embedding <=> '${v}'::vector(384)) d,
              row_number() over (order by e.embedding <=> '${v}'::vector(384)) rn
            from nutrition_food_embeddings e
            join nutrition_foods_master m on m.source=e.source and m.source_id=e.source_id
            order by e.embedding <=> '${v}'::vector(384) limit 5) s`;
  });
  writeFileSync(`sem_${which}/b_${n}.sql`, parts.join('\nunion all\n') + '\norder by idx, rn');
  n++;
}
console.log(which,'batches',n);
