import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const corpus = JSON.parse(readFileSync('corpus.json','utf8'));
// deterministic PRNG
let s = 1337; const rnd = () => (s = (s*1664525+1013904223)>>>0) / 2**32;
const head = corpus.slice(0,150);
const tail = corpus.slice(150).filter(r=>r.nm.length<80);
// shuffle tail deterministically, take 150
const shuffled = tail.map(r=>({r,k:rnd()})).sort((a,b)=>a.k-b.k).map(x=>x.r);
const sample = [...head, ...shuffled.slice(0,150)].map((r,i)=>{
  const t = extractIngredientTerms(r.nm);
  return { idx:i, name:r.nm, freq:r.c, query:t.normalized, head:t.core[0]??'', stratum: i<150?'head':'tail' };
});
writeFileSync('sample.json', JSON.stringify(sample,null,1));
const headCov = head.reduce((a,r)=>a+r.c,0), total = corpus.reduce((a,r)=>a+r.c,0);
console.log(`sample=${sample.length} head-150 covers ${(headCov/total*100).toFixed(1)}% of occurrences`);
console.log('empty queries:', sample.filter(x=>!x.query).length);
