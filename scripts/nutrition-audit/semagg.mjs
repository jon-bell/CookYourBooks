import { readFileSync, writeFileSync } from 'node:fs';
const ds=new Map(JSON.parse(readFileSync('audit_dataset.json','utf8')).map(r=>[r.idx,r]));
const lex=new Map(JSON.parse(readFileSync('graded_all.json','utf8')).map(r=>[r.idx,r]));
let S=[]; for(let i=0;i<6;i++) S.push(...JSON.parse(readFileSync(`semgraded_${i}.json`,'utf8')));
S=S.map(g=>{const d=ds.get(g.idx);return{...g,stratum:d.stratum,freq:d.freq,name:d.name};});
writeFileSync('semgraded_all.json',JSON.stringify(S,null,1));
const V=['CORRECT','ACCEPTABLE','WRONG_VARIANT','WRONG_FOOD','UNUSABLE'];
const usable=v=>v==='CORRECT'||v==='ACCEPTABLE';
function tab(rows,key,label){
  const c={};let n=rows.length,wn=0,wg=0;
  for(const r of rows){c[r[key]]=(c[r[key]]||0)+1;wn+=r.freq;if(usable(r[key]))wg+=r.freq;}
  const g=rows.filter(r=>usable(r[key])).length;
  console.log(`${label.padEnd(34)} usable ${String(g).padStart(3)}/${n} (${(g/n*100).toFixed(1).padStart(5)}%)  occ-wtd ${(wg/wn*100).toFixed(1).padStart(5)}%   [${V.map(v=>`${v[0]}${v==='WRONG_VARIANT'?'V':v==='WRONG_FOOD'?'F':''}:${c[v]||0}`).join(' ')}]`);
}
console.log('=== SEMANTIC ===');
tab(S,'verdict_a','A cleaned query — all 300');
tab(S,'verdict_b','B raw string   — all 300');
tab(S.filter(r=>r.stratum==='head'),'verdict_a','A — head (common)');
tab(S.filter(r=>r.stratum==='tail'),'verdict_a','A — tail');
console.log('\n=== HEAD-TO-HEAD vs LEXICAL (same 300 items, same scale) ===');
const obs=S.filter(r=>lex.get(r.idx).path!=='semantic_fallback');
const lexObs=obs.map(r=>lex.get(r.idx));
console.log(`lexical+mapping (observable, n=${obs.length}): usable ${lexObs.filter(r=>usable(r.verdict)).length} (${(lexObs.filter(r=>usable(r.verdict)).length/obs.length*100).toFixed(1)}%)`);
console.log(`semantic A on those same items:                usable ${obs.filter(r=>usable(r.verdict_a)).length} (${(obs.filter(r=>usable(r.verdict_a)).length/obs.length*100).toFixed(1)}%)`);
// the 47 that today fall through to semantic: how good is semantic there?
const fb=S.filter(r=>lex.get(r.idx).path==='semantic_fallback');
console.log(`\n=== the ${fb.length} items that TODAY fall through to semantic ===`);
tab(fb,'verdict_a','  semantic actually delivers');
// oracle union
const union=S.filter(r=>usable(r.verdict_a)||usable(lex.get(r.idx).verdict)).length;
console.log(`\nORACLE union (best of lexical OR semantic, perfect selector): ${union}/300 (${(union/300*100).toFixed(1)}%)`);
