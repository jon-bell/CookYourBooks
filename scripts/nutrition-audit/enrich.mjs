import { readFileSync, writeFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const replay = JSON.parse(readFileSync('replay.json','utf8'));
const sample = JSON.parse(readFileSync('sample.json','utf8'));
const md = new Map(JSON.parse(readFileSync('mapped_desc.json','utf8')).map(r=>[String(r.source_id),r]));
const meta = new Map(sample.map(s=>[s.idx,s]));

// Port of edge fn lexicalIsWeak
function lexicalIsWeak(name, hits){
  if (hits.length===0) return true;
  const core = extractIngredientTerms(name).core[0];
  if (!core) return false;
  const top = (hits[0].desc ?? '').toLowerCase();
  const stem = core.length>4 ? core.slice(0,core.length-1) : core;
  return !top.includes(stem);
}
const out = replay.map(r=>{
  const m = meta.get(r.idx);
  const hits = r.hits ?? [];
  const weak = lexicalIsWeak(r.name, hits);
  const mapped = r.mapped_source_id ? md.get(String(r.mapped_source_id)) : null;
  let path, match;
  if (mapped) { path='platform_mapping'; match={source_id:String(r.mapped_source_id), desc:mapped.description, data_type:mapped.data_type, kcal:mapped.calories_kcal}; }
  else if (!weak) { path='lexical'; match={source_id:hits[0].source_id, desc:hits[0].desc, data_type:hits[0].data_type, kcal:hits[0].kcal}; }
  else { path='semantic_fallback'; match=null; }
  return { idx:r.idx, stratum:m.stratum, name:r.name, freq:m.freq, query:r.query, head:m.head,
           path, auto_match:match, lexical_weak:weak, lexical_top5:hits };
});
writeFileSync('audit_dataset.json', JSON.stringify(out,null,1));
const by = k => out.reduce((a,r)=>(a[r[k]]=(a[r[k]]||0)+1,a),{});
console.log('by path:', JSON.stringify(by('path')));
console.log('null-kcal auto-matches:', out.filter(r=>r.auto_match && (r.auto_match.kcal===null)).length);
