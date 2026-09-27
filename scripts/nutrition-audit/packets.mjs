import { readFileSync, writeFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('audit_dataset.json','utf8'));
const N=6, per=Math.ceil(d.length/N);
for(let p=0;p<N;p++){
  const slice=d.slice(p*per,(p+1)*per);
  let s='';
  for(const r of slice){
    s+=`\n### [${r.idx}] "${r.name}"  (freq=${r.freq}, stratum=${r.stratum})\n`;
    s+=`cleaned query : "${r.query}"   head noun: "${r.head}"\n`;
    s+=`match path    : ${r.path}\n`;
    s+=`AUTO-MATCH    : ${r.auto_match ? `[${r.auto_match.source_id}] ${r.auto_match.desc}  (${r.auto_match.data_type}, ${r.auto_match.kcal===null?'NO CALORIE DATA':r.auto_match.kcal+' kcal/100g'})` : 'NONE from lexical — falls through to semantic search (result unknown)'}\n`;
    s+=`lexical top-5 candidates:\n`;
    if(r.lexical_top5.length===0) s+=`  (none)\n`;
    for(const h of r.lexical_top5) s+=`  ${h.rank}. [${h.source_id}] ${h.desc}  (${h.data_type}, ${h.kcal===null?'NO CALORIES':h.kcal+' kcal'})\n`;
  }
  writeFileSync(`packet_${p}.md`, s);
}
console.log('packets written, per =',per);
