import { readFileSync, writeFileSync } from 'node:fs';
const ds=new Map(JSON.parse(readFileSync('audit_dataset.json','utf8')).map(r=>[r.idx,r]));
const grp=(f)=>{const m=new Map();for(const r of JSON.parse(readFileSync(f,'utf8'))){if(!m.has(r.idx))m.set(r.idx,[]);m.get(r.idx).push(r);}return m;};
const C=grp('sem_clean.json'), R=grp('sem_raw.json');
// quick stats
let nullTop=0, lowCos=0;
for(const [i,h] of C){ if(h[0].calories_kcal===null) nullTop++; if(h[0].cosine<0.85) lowCos++; }
console.log(`semantic(clean) top-1 with NULL calories: ${nullTop}/300`);
console.log(`semantic(clean) top-1 cosine < 0.85:      ${lowCos}/300`);
const cs=[...C.values()].map(h=>h[0].cosine).sort((a,b)=>a-b);
console.log(`cosine distribution: min=${cs[0]} p25=${cs[75]} median=${cs[150]} p75=${cs[225]} max=${cs[299]}`);
// packets: 6 x 50, semantic-only, blind
const idxs=[...ds.keys()].sort((a,b)=>a-b);
for(let p=0;p<6;p++){
  let s='';
  for(const i of idxs.slice(p*50,(p+1)*50)){
    const d=ds.get(i), c=C.get(i), r=R.get(i);
    s+=`\n### [${i}] "${d.name}"  (freq=${d.freq}, stratum=${d.stratum})\n`;
    s+=`cleaned query: "${d.query}"\n`;
    s+=`SEMANTIC-A pick (query = cleaned terms):\n`;
    s+=`  => [${c[0].source_id}] ${c[0].description}  (${c[0].data_type}, ${c[0].calories_kcal===null?'NO CALORIE DATA':c[0].calories_kcal+' kcal'}, cos=${c[0].cosine})\n`;
    s+=`  runners-up: ${c.slice(1).map(x=>`${x.description} (${x.cosine})`).join(' | ')}\n`;
    s+=`SEMANTIC-B pick (query = raw ingredient string):\n`;
    s+=`  => [${r[0].source_id}] ${r[0].description}  (${r[0].data_type}, ${r[0].calories_kcal===null?'NO CALORIE DATA':r[0].calories_kcal+' kcal'}, cos=${r[0].cosine})\n`;
    s+=`  runners-up: ${r.slice(1).map(x=>`${x.description} (${x.cosine})`).join(' | ')}\n`;
  }
  writeFileSync(`sempacket_${p}.md`, s);
}
console.log('packets written');
