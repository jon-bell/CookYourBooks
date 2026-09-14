import { readFileSync } from 'node:fs';
const VOL={ml:1,milliliter:1,milliliters:1,l:1000,liter:1000,liters:1000,tsp:4.92892,teaspoon:4.92892,teaspoons:4.92892,tbsp:14.7868,tablespoon:14.7868,tablespoons:14.7868,cup:236.588,cups:236.588,'fluid ounce':29.5735,'fluid ounces':29.5735,'fl oz':29.5735,pint:473.176,pints:473.176,quart:946.353,quarts:946.353,gallon:3785.41};
const MASS={g:1,gram:1,grams:1,kg:1000,kilogram:1000,kilograms:1000,mg:.001,milligram:.001,milligrams:.001,oz:28.3495,ounce:28.3495,ounces:28.3495,lb:453.592,pound:453.592,pounds:453.592};
const tok=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
const occ=JSON.parse(readFileSync('occ.json','utf8'));
const gconv=JSON.parse(readFileSync('gconv.json','utf8')).filter(r=>true);
const rep=new Map(JSON.parse(readFileSync('full_replay.json','utf8')).map(r=>[r.name,r]));
const ports=new Map(JSON.parse(readFileSync('matched_portions.json','utf8')).map(r=>[String(r.source_id),r.portions||[]]));

let tot=0; const B={};
const bump=(k,c)=>B[k]=(B[k]||0)+c;
const unresolvedByUnit={};
for(const o of occ){
  tot+=o.c;
  if(o.ty!=='MEASURED'){ bump('VAGUE_no_quantity',o.c); continue; }
  const m=rep.get(o.nm);
  const foodOk = m && m.source_id && m.calories_kcal!==null;
  const u=o.un.trim();
  // resolve grams
  let src=null;
  const rt=new Set(tok(o.nm));
  for(const r of gconv){
    if((r.from_unit||'').toLowerCase()!==u) continue;
    if(r.ingredient_name==null){ src=src||'density_generic'; continue; }
    const ruleT=tok(r.ingredient_name);
    if(ruleT.length&&ruleT.every(t=>rt.has(t))){ src='density_named'; break; }
  }
  if(!src && m && m.source_id){
    const p=(ports.get(String(m.source_id))||[]).find(x=>String(x.unit).toLowerCase()===u);
    if(p) src='portion';
  }
  if(!src && MASS[u]!=null) src='mass';
  if(!src && VOL[u]!=null) src='water_equiv_APPROX';
  if(!src){ src='UNRESOLVED'; unresolvedByUnit[u||'(blank)']=(unresolvedByUnit[u||'(blank)']||0)+o.c; }
  if(src==='UNRESOLVED') bump('grams_UNRESOLVED',o.c);
  else if(!foodOk) bump('grams_ok_but_NO_FOOD_FACTS',o.c);
  else if(src==='water_equiv_APPROX') bump('contributes_but_WATER_DENSITY_GUESS',o.c);
  else bump('fully_resolved',o.c);
}
console.log(`TOTAL ingredient occurrences: ${tot}\n`);
for(const [k,v] of Object.entries(B).sort((a,b)=>b[1]-a[1]))
  console.log(k.padEnd(36), String(v).padStart(6), (v/tot*100).toFixed(1)+'%');
console.log('\ntop units that fail gram conversion:');
Object.entries(unresolvedByUnit).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([u,c])=>console.log('  ',String(c).padStart(5),u));
