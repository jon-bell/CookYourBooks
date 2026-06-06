#!/usr/bin/env node
// Seeds the Apple Beta App Review demo account on the hosted Supabase
// project. Idempotent — re-running just no-ops on duplicates.
//
// Reads from the .secrets file at the repo root (which is gitignored;
// never commit secrets here):
//   VITE_SUPABASE_URL              — hosted project URL (required)
//   VITE_SUPABASE_ANON_KEY         — publishable key for signin (required)
//   SUPABASE_SECRET_KEY            — sb_secret_* service-role key (required)
//   APPLE_REVIEW_DEMO_PASSWORD     — password to set/reset on the
//                                    apple-review@cookyourbooks.app user (required)
//   GEMINI_API_KEY                 — pinned on the demo account so the
//                                    reviewer can test the OCR + video-link
//                                    import flows (optional; warns if missing).
//                                    Stored encrypted in vault.secrets;
//                                    clients only ever see the fingerprint,
//                                    never the raw key, so no rotation is
//                                    needed after Apple's review.
//
// Usage: node scripts/seed-apple-demo-account.mjs

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, '..', '.secrets'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const URL = (env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SECRET = env.SUPABASE_SECRET_KEY;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const PASSWORD = env.APPLE_REVIEW_DEMO_PASSWORD;
const GEMINI_KEY = env.GEMINI_API_KEY; // optional
if (!URL || !SECRET || !ANON || !PASSWORD) {
  console.error(
    'Missing one of VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ' +
      'SUPABASE_SECRET_KEY, APPLE_REVIEW_DEMO_PASSWORD in .secrets',
  );
  process.exit(1);
}

const HDR = {
  apikey: SECRET,
  Authorization: `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
};

const EMAIL = 'apple-review@cookyourbooks.app';
const DISPLAY = 'Apple Review';

async function api(path, init = {}) {
  const r = await fetch(`${URL}${path}`, {
    ...init,
    headers: { ...HDR, ...(init.headers || {}) },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${init.method || 'GET'} ${path} → ${r.status}: ${body}`);
  }
  if (r.status === 204) return null;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

async function getOrCreateUser() {
  // GoTrue admin: list with email filter.
  const list = await api(
    `/auth/v1/admin/users?email=${encodeURIComponent(EMAIL)}`,
  );
  const existing = list.users?.find?.((u) => u.email === EMAIL);
  if (existing) {
    await api(`/auth/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
    });
    console.log(`User exists: id=${existing.id} (password reset)`);
    return existing.id;
  }
  const created = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: DISPLAY },
    }),
  });
  console.log(`User created: id=${created.id}`);
  return created.id;
}

async function wipeUsersContent(userId) {
  // Cascades through recipes / ingredients / instructions.
  await api(
    `/rest/v1/recipe_collections?owner_id=eq.${userId}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
  );
}

async function insertRows(table, rows) {
  if (!rows.length) return;
  await api(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
}

async function insertCollection({ ownerId, sourceType, title, fields }) {
  const id = randomUUID();
  await insertRows('recipe_collections', [
    {
      id,
      owner_id: ownerId,
      source_type: sourceType,
      title,
      is_public: false,
      moderation_state: 'ACTIVE',
      ...fields,
    },
  ]);
  return id;
}

async function insertRecipe({
  collectionId,
  title,
  fields,
  ingredients,
  instructions,
}) {
  const id = randomUUID();
  await insertRows('recipes', [
    {
      id,
      collection_id: collectionId,
      title,
      sort_order: 0,
      starred: false,
      ...fields,
    },
  ]);
  if (ingredients?.length) {
    await insertRows(
      'ingredients',
      ingredients.map((i, idx) => ({
        id: randomUUID(),
        recipe_id: id,
        sort_order: idx,
        type: i.type,
        name: i.name,
        preparation: i.preparation ?? null,
        quantity_type: i.qtyType ?? null,
        quantity_amount: i.amount ?? null,
        quantity_unit: i.unit ?? null,
        quantity_whole: i.whole ?? null,
        quantity_numerator: i.num ?? null,
        quantity_denominator: i.den ?? null,
        quantity_min: i.min ?? null,
        quantity_max: i.max ?? null,
      })),
    );
  }
  if (instructions?.length) {
    await insertRows(
      'instructions',
      instructions.map((t, idx) => ({
        id: randomUUID(),
        recipe_id: id,
        step_number: idx + 1,
        text: t,
      })),
    );
  }
  return id;
}

function measured(name, amount, unit, preparation) {
  return { type: 'MEASURED', name, qtyType: 'EXACT', amount, unit, preparation };
}
function vague(name, preparation) {
  return { type: 'VAGUE', name, preparation };
}

async function main() {
  const userId = await getOrCreateUser();
  await wipeUsersContent(userId);

  // === Cookbook 1: OCR-imported ===
  const c1 = await insertCollection({
    ownerId: userId,
    sourceType: 'PUBLISHED_BOOK',
    title: 'The Joy of Cooking',
    fields: {
      author: 'Irma S. Rombauer',
      publisher: 'Scribner',
      publication_year: 2019,
      isbn: '9781501169717',
      notes: 'Pages snapped during the OCR import flow.',
    },
  });
  await insertRecipe({
    collectionId: c1,
    title: 'Buttermilk Pancakes',
    fields: {
      page_numbers: [712],
      servings_amount: 4,
      servings_description: 'servings (about 12 pancakes)',
      time_estimate: '25 min',
      description: 'Light, tangy, and reliably fluffy weekend pancakes.',
    },
    ingredients: [
      measured('all-purpose flour', 1.5, 'cup'),
      measured('baking powder', 2, 'tsp'),
      measured('baking soda', 0.5, 'tsp'),
      measured('granulated sugar', 1, 'tbsp'),
      measured('kosher salt', 0.5, 'tsp'),
      measured('buttermilk', 1.75, 'cup'),
      measured('large eggs', 2, 'whole'),
      measured('unsalted butter', 3, 'tbsp', 'melted'),
    ],
    instructions: [
      'Whisk the dry ingredients in a large bowl.',
      'Whisk the buttermilk, eggs, and melted butter in a second bowl.',
      'Pour the wet into the dry. Stir until just combined — lumps are fine.',
      'Heat a non-stick skillet over medium. Ladle ¼ cup per pancake.',
      'Flip when the surface is bubbly and the edges look dry, ~2 min/side.',
    ],
  });
  await insertRecipe({
    collectionId: c1,
    title: 'Chocolate Chip Cookies',
    fields: {
      page_numbers: [821],
      servings_amount: 24,
      servings_description: 'cookies',
      time_estimate: '40 min',
    },
    ingredients: [
      measured('all-purpose flour', 2.25, 'cup'),
      measured('baking soda', 1, 'tsp'),
      measured('kosher salt', 1, 'tsp'),
      measured('unsalted butter', 1, 'cup', 'softened'),
      measured('packed brown sugar', 0.75, 'cup'),
      measured('granulated sugar', 0.75, 'cup'),
      measured('large eggs', 2, 'whole'),
      measured('vanilla extract', 1, 'tsp'),
      measured('semisweet chocolate chips', 2, 'cup'),
    ],
    instructions: [
      'Preheat oven to 375°F. Whisk flour, baking soda, and salt.',
      'Cream butter and sugars in a stand mixer until pale and fluffy, ~3 min.',
      'Beat in eggs one at a time, then the vanilla.',
      'Mix in the flour mixture on low until just incorporated.',
      'Fold in chocolate chips by hand.',
      'Drop rounded tablespoons onto sheet pans. Bake 9–11 min until edges are golden.',
    ],
  });

  // === Cookbook 2: personal, hand-typed ===
  const c2 = await insertCollection({
    ownerId: userId,
    sourceType: 'PERSONAL',
    title: 'Weeknight Standbys',
    fields: {
      description: 'Things I cook when I have 30 minutes and no plan.',
      notes: 'Hand-typed.',
    },
  });
  await insertRecipe({
    collectionId: c2,
    title: 'One-pot Lemon Chicken Orzo',
    fields: {
      servings_amount: 4,
      servings_description: 'servings',
      time_estimate: '30 min',
      starred: true,
    },
    ingredients: [
      measured('boneless skinless chicken thighs', 1.25, 'lb'),
      measured('olive oil', 2, 'tbsp'),
      measured('shallot', 1, 'whole', 'finely chopped'),
      measured('garlic cloves', 3, 'whole', 'thinly sliced'),
      measured('dry orzo', 1.5, 'cup'),
      measured('low-sodium chicken broth', 3, 'cup'),
      measured('lemon', 1, 'whole', 'juiced + zested'),
      vague('kosher salt'),
      vague('black pepper'),
      measured('baby spinach', 4, 'cup'),
      measured('grated parmesan', 0.5, 'cup'),
    ],
    instructions: [
      'Pat chicken dry; season generously with salt and pepper.',
      'Heat oil in a deep skillet over medium-high. Sear chicken 4 min per side; remove.',
      'Lower heat to medium. Cook shallot 2 min; add garlic for the last 30 sec.',
      'Stir in orzo and toast for 1 min. Pour in broth and lemon juice; scrape the pan.',
      'Nestle the chicken back in. Cover; simmer 12 min until orzo is tender.',
      'Stir in spinach + zest. Off heat, fold in parmesan and adjust salt.',
    ],
  });
  await insertRecipe({
    collectionId: c2,
    title: 'Sheet-pan Salmon with Broccoli',
    fields: {
      servings_amount: 2,
      servings_description: 'servings',
      time_estimate: '20 min',
    },
    ingredients: [
      measured('salmon fillets', 2, 'whole', 'skin on, ~6 oz each'),
      measured('broccoli florets', 4, 'cup'),
      measured('olive oil', 3, 'tbsp'),
      measured('garlic cloves', 2, 'whole', 'minced'),
      measured('lemon', 0.5, 'whole', 'sliced'),
      vague('kosher salt'),
      vague('red pepper flakes'),
    ],
    instructions: [
      'Heat oven to 425°F. Toss broccoli with 2 tbsp oil + a pinch of salt + the garlic on a sheet pan.',
      'Roast 8 min. Push broccoli to the edges; add salmon and lemon slices to the middle.',
      'Drizzle salmon with the remaining oil, sprinkle salt and pepper flakes.',
      'Return to oven 8–10 min until salmon flakes at the thickest part.',
    ],
  });

  // === Web collection: video-link imports ===
  const c3 = await insertCollection({
    ownerId: userId,
    sourceType: 'WEBSITE',
    title: 'YouTube imports',
    fields: {
      site_name: 'YouTube',
      source_url: 'https://youtube.com',
      description: 'Recipes scraped from recipe-video links via the share extension.',
    },
  });
  await insertRecipe({
    collectionId: c3,
    title: "Adam Ragusea's Crusty No-Knead Bread",
    fields: {
      source_url: 'https://www.youtube.com/watch?v=13Ah9ES2yTU',
      time_estimate: '12+ hr (mostly inactive)',
      servings_amount: 1,
      servings_description: 'loaf',
      description: 'Auto-extracted from the YouTube link via the video-import edge function.',
    },
    ingredients: [
      measured('bread flour', 500, 'g'),
      measured('water', 380, 'g', 'lukewarm'),
      measured('kosher salt', 10, 'g'),
      measured('instant yeast', 1, 'g'),
    ],
    instructions: [
      'Mix everything in a big bowl with a wooden spoon. No kneading. Cover.',
      'Let sit at room temperature 12–18 hours until tripled in volume.',
      'Tip onto a heavily floured surface; gently shape into a round; flour the top.',
      'Rest 30 min while preheating a Dutch oven inside the oven at 500°F.',
      'Drop dough into the hot Dutch oven, cover, bake 25 min.',
      'Uncover, drop heat to 450°F, bake another 15–20 min until very dark golden.',
    ],
  });

  // === Pin Gemini key (so reviewer can exercise OCR + video-link import) ===
  if (GEMINI_KEY) {
    // ocr_key_set is SECURITY DEFINER keyed off auth.uid(), so we have
    // to call it as the demo user, not as service role. Sign in via the
    // publishable key + signInWithPassword (just like the real client
    // does) and use the resulting access_token on the RPC call.
    const signin = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!signin.ok) {
      console.error(
        'Demo signin failed; cannot set Gemini key:',
        await signin.text(),
      );
    } else {
      const { access_token } = await signin.json();
      const rpc = await fetch(`${URL}/rest/v1/rpc/ocr_key_set`, {
        method: 'POST',
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_provider: 'gemini',
          p_raw_key: GEMINI_KEY,
          p_base_url: null,
        }),
      });
      if (rpc.ok) {
        console.log(`  Gemini key pinned (fingerprint …${GEMINI_KEY.slice(-4)})`);
      } else {
        console.error('ocr_key_set RPC failed:', rpc.status, await rpc.text());
      }
    }
  } else {
    console.log(
      '  (GEMINI_API_KEY not in .secrets — skipping. OCR/video import ' +
        'will prompt for a key on the demo account.)',
    );
  }

  console.log('\nDemo account ready.');
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  Seeded:   3 collections, 5 recipes${GEMINI_KEY ? ', Gemini key pinned' : ''}`);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
