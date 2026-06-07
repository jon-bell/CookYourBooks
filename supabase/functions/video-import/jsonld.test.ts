// `deno test supabase/functions/video-import/jsonld.test.ts`
import {
  assertEquals,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { extractJsonLdRecipes, extractSiteName, schemaRecipeToContract } from './jsonld.ts';
import { parseLlmJson } from './parser.ts';

// A realistic page: the Recipe is nested inside an @graph alongside other
// entities, instructions are HowToStep objects, yield is a string.
const PAGE = `<!doctype html><html><head>
<meta property="og:site_name" content="Serious Eats">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "name": "Serious Eats" },
    {
      "@type": "Recipe",
      "name": "Classic Pancakes",
      "description": "Fluffy weekend pancakes.",
      "recipeYield": "Makes 4 servings",
      "recipeIngredient": [
        "2 cups all-purpose flour, sifted",
        "1 1/2 tsp baking powder",
        "2 eggs",
        "salt to taste"
      ],
      "recipeInstructions": [
        { "@type": "HowToStep", "text": "Whisk the dry ingredients." },
        { "@type": "HowToStep", "text": "Fold in the eggs." }
      ]
    }
  ]
}
</script></head><body>blah</body></html>`;

Deno.test('extractJsonLdRecipes finds the Recipe inside @graph', () => {
  const recipes = extractJsonLdRecipes(PAGE);
  assertEquals(recipes.length, 1);
  assertEquals(recipes[0]!.name, 'Classic Pancakes');
});

Deno.test('schemaRecipeToContract → parseLlmJson yields a structured draft', () => {
  const recipe = extractJsonLdRecipes(PAGE)[0]!;
  const drafts = parseLlmJson(JSON.stringify({ recipes: [schemaRecipeToContract(recipe)] }));
  assertEquals(drafts.length, 1);
  const d = drafts[0]!;
  assertEquals(d.title, 'Classic Pancakes');
  assertEquals(d.description, 'Fluffy weekend pancakes.');
  assertEquals(d.servings?.amount, 4);
  assertEquals(d.instructions.length, 2);
  assertEquals(d.instructions[0]!.text, 'Whisk the dry ingredients.');

  // "2 cups all-purpose flour, sifted" → measured w/ canonical unit + prep.
  const flour = d.ingredients.find((i) => i.name === 'all-purpose flour');
  assert(flour, 'flour ingredient parsed');
  assertEquals(flour!.type, 'MEASURED');
  if (flour!.type === 'MEASURED') {
    assertEquals(flour!.quantity.type, 'EXACT');
    assertEquals(flour!.quantity.unit, 'cup');
  }

  // "1 1/2 tsp baking powder" → fractional teaspoon.
  const bp = d.ingredients.find((i) => i.name === 'baking powder');
  assert(bp && bp.type === 'MEASURED' && bp.quantity.type === 'FRACTIONAL');

  // "salt to taste" → vague.
  const salt = d.ingredients.find((i) => i.name === 'salt');
  assert(salt && salt.type === 'VAGUE');
});

Deno.test('extractSiteName prefers og:site_name then hostname', () => {
  assertEquals(extractSiteName(PAGE, 'https://www.seriouseats.com/x'), 'Serious Eats');
  assertEquals(extractSiteName('<html></html>', 'https://www.bonappetit.com/x'), 'bonappetit.com');
});

Deno.test('a string recipeInstructions block splits on newlines', () => {
  const recipe = { name: 'X', recipeInstructions: 'Step one.\nStep two.\n\nStep three.' };
  const contract = schemaRecipeToContract(recipe);
  const drafts = parseLlmJson(JSON.stringify({ recipes: [contract] }));
  assertEquals(drafts[0]!.instructions.length, 3);
});

Deno.test('no JSON-LD Recipe → empty list (caller falls back to LLM)', () => {
  assertEquals(extractJsonLdRecipes('<html><body>no recipe here</body></html>').length, 0);
});
