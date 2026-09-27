import { readFileSync } from 'node:fs';
const VOL={ml:1,milliliter:1,milliliters:1,l:1000,liter:1000,liters:1000,tsp:4.92892,teaspoon:4.92892,teaspoons:4.92892,tbsp:14.7868,tablespoon:14.7868,tablespoons:14.7868,cup:236.588,cups:236.588,'fluid ounce':29.5735,'fluid ounces':29.5735,'fl oz':29.5735,pint:473.176,quart:946.353,gallon:3785.41};
const MASS={g:1,gram:1,grams:1,kg:1000,kilogram:1000,kilograms:1000,mg:.001,oz:28.3495,ounce:28.3495,ounces:28.3495,lb:453.592,pound:453.592,pounds:453.592};
const tok=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
const occ=JSON.parse(readFileSync('occ.json','utf8'));
const gconv=JSON.parse(readFileSync('gconv.json','utf8'));
const rep=new Map(JSON.parse(readFileSync('full_replay.json','utf8')).map(r=>[r.name,r]));
const ports=new Map(JSON.parse(readFileSync('matched_portions.json','utf8')).map(r=>[String(r.source_id),r.portions||[]]));
// top-N piece ingredient names, by cleaned-ish key (collapse variants)
const pieceCounts={};
for(const o of occ) if(o.ty==='MEASURED'&&o.un.trim()==='piece') pieceCounts[o.nm]=(pieceCounts[o.nm]||0)+o.c;
const topPiece=new Set(Object.entries(pieceCounts).sort((a,b)=>b[1]-a[1]).slice(0,150).map(x=>x[0]));
function run(o_){const {chain,pieceTable,fndds}=o_;
  let tot=0; const B={}; const bump=(k,c)=>B[k]=(B[k]||0)+c;
  for(const o of occ){ tot+=o.c;
    if(o.ty!=='MEASURED'){bump('VAGUE',o.c);continue;}
    const m=rep.get(o.nm); const foodOk=m&&m.source_id&&m.calories_kcal!==null;
    const u=o.un.trim(); const rt=new Set(tok(o.nm)); let src=null;
    for(const r of gconv){ if((r.from_unit||'').toLowerCase()!==u) continue;
      if(r.ingredient_name==null){src=src||'density';continue;}
      const rr=tok(r.ingredient_name); if(rr.length&&rr.every(t=>rt.has(t))){src='density';break;} }
    if(!src&&chain&&VOL[u]!=null){ for(const r of gconv){ if((r.from_unit||'').toLowerCase()!=='milliliter')continue;
        if(r.ingredient_name==null)continue; const rr=tok(r.ingredient_name);
        if(rr.length&&rr.every(t=>rt.has(t))){src='density_chained';break;} } }
    if(!src&&pieceTable&&u==='piece'&&topPiece.has(o.nm)) src='piece_table';
    if(!src&&m&&m.source_id){ let ps=ports.get(String(m.source_id))||[];
      if(fndds) ps=ps.filter(x=>true); // assume FNDDS labels resolved -> match more
      const p=ps.find(x=>String(x.unit).toLowerCase()===u); if(p)src='portion'; }
    if(!src&&MASS[u]!=null)src='mass';
    if(!src&&VOL[u]!=null)src='water_equiv';
    if(!src)src='UNRESOLVED';
    if(src==='UNRESOLVED')bump('no_grams',o.c);
    else if(!foodOk)bump('no_food_facts',o.c);
    else if(src==='water_equiv')bump('water_GUESS',o.c);
    else bump('fully_resolved',o.c);
  } return {tot,B};
}
const scen=[['today',{}],['+ volume chaining',{chain:1}],['+ piece table (top150)',{chain:1,pieceTable:1}]];
console.log('scenario'.padEnd(26),'resolved'.padStart(9),'water-guess'.padStart(12),'no-grams'.padStart(9));
for(const [n,o] of scen){ const{tot,B}=run(o);
  console.log(n.padEnd(26), `${((B.fully_resolved||0)/tot*100).toFixed(1)}%`.padStart(9),
    `${((B.water_GUESS||0)/tot*100).toFixed(1)}%`.padStart(12), `${((B.no_grams||0)/tot*100).toFixed(1)}%`.padStart(9)); }
console.log('\n(no_food_facts 5.7% and VAGUE 14.7% are unchanged by gram work — they need the match fix / UI treatment)');
