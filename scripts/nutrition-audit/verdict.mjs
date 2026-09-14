import { readFileSync } from 'node:fs';
const lex=new Map(JSON.parse(readFileSync('graded_all.json','utf8')).map(r=>[r.idx,r]));
const sem=new Map(JSON.parse(readFileSync('semgraded_all.json','utf8')).map(r=>[r.idx,r]));
const ds=new Map(JSON.parse(readFileSync('audit_dataset.json','utf8')).map(r=>[r.idx,r]));
const ok=v=>v==='CORRECT'||v==='ACCEPTABLE';
let good=0,wn=0,wg=0;
const remaining=[];
for(const [i,d] of ds){
  const L=lex.get(i), S=sem.get(i);
  const live = d.path==='semantic_fallback' ? S.verdict_a : L.verdict;   // what prod actually serves
  wn+=d.freq;
  if(ok(live)){good++;wg+=d.freq;} else remaining.push({i,name:d.name,freq:d.freq,live,
    lexOk:ok(L.verdict), semOk:ok(S.verdict_a), path:d.path,
    fm:d.path==='semantic_fallback'?S.failure_mode_a:L.failure_mode});
}
console.log(`TRUE CURRENT SYSTEM (mapping + lexical + real semantic fallback):`);
console.log(`  usable ${good}/300 = ${(good/300*100).toFixed(1)}%   occurrence-weighted ${(wg/wn*100).toFixed(1)}%\n`);
console.log(`Of the ${remaining.length} failures, is the OTHER path right?`);
const otherRight=remaining.filter(r=> (r.path==='semantic_fallback'? r.lexOk : r.semOk));
console.log(`  fixable by choosing the other retrieval path: ${otherRight.length} (${(otherRight.length/remaining.length*100).toFixed(0)}%)`);
console.log(`  neither path has it:                          ${remaining.length-otherRight.length} (${((remaining.length-otherRight.length)/remaining.length*100).toFixed(0)}%)  <- data/corpus work, not retrieval\n`);
const fm={}; for(const r of remaining) if(r.fm) fm[r.fm]=(fm[r.fm]||0)+1;
console.log('remaining failure modes:');
Object.entries(fm).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
