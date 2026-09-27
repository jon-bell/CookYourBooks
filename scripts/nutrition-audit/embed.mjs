import { pipeline } from '@huggingface/transformers';
import { readFileSync, writeFileSync } from 'node:fs';
const texts = JSON.parse(readFileSync(process.argv[2],'utf8'));
process.stderr.write(`loading Xenova/gte-small (q8)…\n`);
const ex = await pipeline('feature-extraction','Xenova/gte-small',{dtype:'q8'});
const out=[];
for(let i=0;i<texts.length;i++){
  const o = await ex(texts[i], {pooling:'mean', normalize:true});
  const a = o.data instanceof Float32Array ? o.data : Float32Array.from(o.data);
  if(a.length!==384) throw new Error('dim '+a.length);
  out.push(Array.from(a).map(x=>Number(x.toFixed(6))));
  if(i%25===0) process.stderr.write(`  ${i}/${texts.length}\r`);
}
writeFileSync(process.argv[3], JSON.stringify(out));
process.stderr.write(`\ndone ${out.length}\n`);
