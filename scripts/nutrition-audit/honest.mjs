import { readFileSync } from 'node:fs';
const all=JSON.parse(readFileSync('graded_all.json','utf8'));
const obs=all.filter(r=>r.path!=='semantic_fallback');
const sem=all.filter(r=>r.path==='semantic_fallback');
const u=rs=>rs.filter(r=>r.verdict==='CORRECT'||r.verdict==='ACCEPTABLE');
const W=rs=>rs.reduce((a,r)=>a+r.freq,0);
console.log(`OBSERVABLE decisions (mapping+lexical): n=${obs.length}  usable=${u(obs).length} (${(u(obs).length/obs.length*100).toFixed(1)}%)`);
console.log(`   occurrence-weighted usable: ${(W(u(obs))/W(obs)*100).toFixed(1)}%`);
console.log(`UNKNOWN (semantic fallback, not visible to graders): n=${sem.length}, occ=${W(sem)}`);
const lo=u(obs).length/all.length*100, hi=(u(obs).length+sem.length)/all.length*100;
const wlo=W(u(obs))/W(all)*100, whi=(W(u(obs))+W(sem))/W(all)*100;
console.log(`\nTRUE OVERALL USABLE RATE is bounded: ${lo.toFixed(1)}% .. ${hi.toFixed(1)}%  (by distinct name)`);
console.log(`                                     ${wlo.toFixed(1)}% .. ${whi.toFixed(1)}%  (occurrence-weighted)`);
// ranking-fixable
const nc=all.filter(r=>r.verdict!=='CORRECT'&&r.verdict!=='ACCEPTABLE');
const fix=nc.filter(r=>r.better_in_top5);
console.log(`\nOf ${nc.length} genuinely-bad matches, ${fix.length} (${(fix.length/nc.length*100).toFixed(0)}%) had a BETTER ROW ALREADY IN TOP-5`);
console.log(`  => pure ranking fix, no corpus or embedding work needed.`);
