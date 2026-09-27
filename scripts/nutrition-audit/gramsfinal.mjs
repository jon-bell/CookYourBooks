import { readFileSync } from 'node:fs';
import { extractIngredientTerms } from './terms.ts';
const VOL={ml:1,milliliter:1,milliliters:1,l:1000,liter:1000,liters:1000,tsp:4.92892,teaspoon:4.92892,teaspoons:4.92892,tbsp:14.7868,tablespoon:14.7868,tablespoons:14.7868,cup:236.588,cups:236.588,'fluid ounce':29.5735,'fluid ounces':29.5735,'fl oz':29.5735,pint:473.176,quart:946.353,gallon:3785.41};
const MASS={g:1,gram:1,grams:1,kg:1000,kilogram:1000,kilograms:1000,mg:.001,oz:28.3495,ounce:28.3495,ounces:28.3495,lb:453.592,pound:453.592,pounds:453.592};
const tok=s=>s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
const occ=JSON.parse(readFileSync('occ.json','utf8'));
const gconv=JSON.parse(readFileSync('gconv.json','utf8'));
function run(repFile,portFile,chain){
  const rep=new Map(JSON.parse(readFileSync(repFile,'utf8')).map(r=>[r.name,r]));
  const ports=new Map(JSON.parse(readFileSync(portFile,'utf8')).map(r=>[String(r.source_id),r.portions||[]]));
  let tot=0; const B={}; const bump=(k,c)=>B[k]=(B[k]||0)+c;
  for(const o of occ){ tot+=o.c;
    if(o.ty!=='MEASURED'){bump('VAGUE',o.c);continue;}
    const m=rep.get(o.nm); const foodOk=m&&m.source_id&&m.calories_kcal!==null;
    const u=o.un.trim(); const rt=new Set(tok(o.nm)); let src=null;
    const best=(unit)=>{let sp=null,sc=0,gen=null;
      for(const r of gconv){ if((r.from_unit||'').toLowerCase()!==unit) continue;
        if(r.ingredient_name==null){gen=r;continue;}
        const rr=tok(r.ingredient_name); if(rr.length&&rr.every(t=>rt.has(t))&&rr.length>sc){sc=rr.length;sp=r;} }
      return sp??gen;};
    if(best(u)) src='density';
    if(!src&&m&&m.source_id){ const p=(ports.get(String(m.source_id))||[]).find(x=>String(x.unit).toLowerCase()===u); if(p)src='portion'; }
    if(!src&&chain&&VOL[u]!=null&&best('milliliter')) src='density_chained';
    if(!src&&MASS[u]!=null)src='mass';
    if(!src&&VOL[u]!=null)src='water_equiv';
    if(!src)src='UNRESOLVED';
    if(src==='UNRESOLVED')bump('no_grams',o.c);
    else if(!foodOk)bump('no_food_facts',o.c);
    else if(src==='water_equiv')bump('water_GUESS',o.c);
    else bump('fully_resolved',o.c);
  } return {tot,B};
}
const rows=[['BEFORE (old matcher, no chaining)','local_replay.json','matched_portions.json',false],
            ['AFTER  (new matcher + chaining)','new_local_replay.json','new_matched_portions.json',true]];
console.log('scenario'.padEnd(34),'resolved'.padStart(9),'water-guess'.padStart(12),'no-grams'.padStart(9),'no-food'.padStart(9));
for(const [label,rf,pf,ch] of rows){ const {tot,B}=run(rf,pf,ch);
  const p=k=>`${((B[k]||0)/tot*100).toFixed(1)}%`;
  console.log(label.padEnd(34),p('fully_resolved').padStart(9),p('water_GUESS').padStart(12),p('no_grams').padStart(9),p('no_food_facts').padStart(9)); }
console.log('\n(VAGUE, 14.7%, is unchanged — those ingredients carry no quantity at all.)');
