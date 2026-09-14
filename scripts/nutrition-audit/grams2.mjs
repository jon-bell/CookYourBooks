import { readFileSync } from 'node:fs';
const VOL={ml:1,milliliter:1,milliliters:1,l:1000,liter:1000,liters:1000,tsp:4.92892,teaspoon:4.92892,teaspoons:4.92892,tbsp:14.7868,tablespoon:14.7868,tablespoons:14.7868,cup:236.588,cups:236.588,'fluid ounce':29.5735,'fluid ounces':29.5735,'fl oz':29.5735,pint:473.176,pints:473.176,quart:946.353,quarts:946.353,gallon:3785.41};
const MASS={g:1,gram:1,grams:1,kg:1000,kilogram:1000,kilograms:1000,mg:.001,milligram:.001,milligrams:.001,oz:28.3495,ounce:28.3495,ounces:28.3495,lb:453.592,pound:453.592,pounds:453.592};
const tok=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
const occ=JSON.parse(readFileSync('occ.json','utf8'));
const gconv=JSON.parse(readFileSync('gconv.json','utf8'));
const rep=new Map(JSON.parse(readFileSync('full_replay.json','utf8')).map(r=>[r.name,r]));
const ports=new Map(JSON.parse(readFileSync('matched_portions.json','utf8')).map(r=>[String(r.source_id),r.portions||[]]));
function run(chainVolume){
  let tot=0; const B={};
  const bump=(k,c)=>B[k]=(B[k]||0)+c;
  for(const o of occ){
    tot+=o.c;
    if(o.ty!=='MEASURED'){ bump('VAGUE',o.c); continue; }
    const m=rep.get(o.nm); const foodOk = m&&m.source_id&&m.calories_kcal!==null;
    const u=o.un.trim(); const rt=new Set(tok(o.nm)); let src=null;
    for(const r of gconv){ if((r.from_unit||'').toLowerCase()!==u) continue;
      if(r.ingredient_name==null){src=src||'density';continue;}
      const rr=tok(r.ingredient_name); if(rr.length&&rr.every(t=>rt.has(t))){src='density';break;} }
    // NEW: chain any volume unit through ml using the per-ml density rules
    if(!src && chainVolume && VOL[u]!=null){
      let best=null;
      for(const r of gconv){ if((r.from_unit||'').toLowerCase()!=='milliliter') continue;
        if(r.ingredient_name==null){ best=best||r; continue; }
        const rr=tok(r.ingredient_name); if(rr.length&&rr.every(t=>rt.has(t))){ best=r; break; } }
      if(best && best.ingredient_name!=null) src='density_chained';
    }
    if(!src && m&&m.source_id){ const p=(ports.get(String(m.source_id))||[]).find(x=>String(x.unit).toLowerCase()===u); if(p) src='portion'; }
    if(!src && MASS[u]!=null) src='mass';
    if(!src && VOL[u]!=null) src='water_equiv';
    if(!src) src='UNRESOLVED';
    if(src==='UNRESOLVED') bump('no_grams',o.c);
    else if(!foodOk) bump('no_food_facts',o.c);
    else if(src==='water_equiv') bump('water_density_GUESS',o.c);
    else bump('fully_resolved',o.c);
  }
  return {tot,B};
}
for(const [label,chain] of [['TODAY',false],['WITH volume->ml chaining',true]]){
  const {tot,B}=run(chain);
  console.log(`\n=== ${label} ===`);
  for(const k of ['fully_resolved','water_density_GUESS','no_grams','VAGUE','no_food_facts'])
    console.log('  '+k.padEnd(22), String(B[k]||0).padStart(6), ((B[k]||0)/tot*100).toFixed(1)+'%');
}
