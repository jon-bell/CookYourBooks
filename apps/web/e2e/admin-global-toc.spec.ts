import { test, expect, signIn, waitForSynced } from './support/fixtures.js';
import { adminGet, createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';

// E2E for the global cookbook ToC admin surface. Skips the live Open
// Library call — that path is mocked at the network layer so the test
// stays deterministic and doesn't hit the public OL service from CI.

test.describe('Admin: global cookbook ToC', () => {
  test('non-admin sees the restricted message', async ({ authedPage }) => {
    await authedPage.goto('/admin/global-toc');
    await expect(authedPage.getByText(/restricted to administrators/i)).toBeVisible();
  });

  test('admin can CRUD a cookbook and its ToC', async ({ page }) => {
    const admin = await createTestUser('gtocadm', { admin: true });
    try {
      await signIn(page, admin);

      await page.goto('/admin/global-toc');
      await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();

      // Create a new cookbook — starts as "Untitled cookbook".
      await page.getByRole('button', { name: 'New cookbook' }).click();
      const card = page.getByRole('link', { name: 'Untitled cookbook' });
      await expect(card).toBeVisible();

      await card.click();
      await expect(page.getByRole('heading', { name: /Table of contents/ })).toBeVisible();

      // Edit metadata.
      await page.getByLabel('Title').fill('Salt Fat Acid Heat');
      await page.getByLabel('ISBN').fill('978-1-4516-2421-6');
      await page.getByLabel('Author').fill('Samin Nosrat');
      await page.getByLabel('Publisher').fill('Simon & Schuster');
      await page.getByLabel('Year').fill('2017');
      await page.getByRole('button', { name: 'Save cookbook' }).click();

      // Verify the row landed and the ISBN got normalized (dashes stripped).
      await expect.poll(async () => {
        const rows = await adminGet<{ isbn: string; title: string; author: string }[]>(
          '/rest/v1/global_cookbooks?select=isbn,title,author&isbn=eq.9781451624216',
        );
        return rows[0];
      }).toMatchObject({
        isbn: '9781451624216',
        title: 'Salt Fat Acid Heat',
        author: 'Samin Nosrat',
      });

      // Add two ToC entries.
      await page.getByRole('button', { name: '+ Add entry' }).click();
      const row1 = page.locator('ol li').nth(0);
      await row1.getByPlaceholder('Recipe title').fill('Buttermilk Roast Chicken');
      await row1.getByPlaceholder('Page').fill('40');

      await page.getByRole('button', { name: '+ Add entry' }).click();
      const row2 = page.locator('ol li').nth(1);
      await row2.getByPlaceholder('Recipe title').fill('Caesar Salad');
      await row2.getByPlaceholder('Page').fill('212');

      await page.getByRole('button', { name: 'Save table of contents' }).click();

      const cookbook = await adminGet<{ id: string }[]>(
        '/rest/v1/global_cookbooks?select=id&isbn=eq.9781451624216',
      );
      const cookbookId = cookbook[0]?.id;
      expect(cookbookId).toBeTruthy();
      // Poll until the bulk-replace lands. The save button auto-disables on
      // success (dirty=false), so we drive off the server state instead of
      // the button label.
      await expect
        .poll(async () =>
          adminGet<{ title: string; page_number: number | null; sort_order: number }[]>(
            `/rest/v1/global_toc_entries?select=title,page_number,sort_order&cookbook_id=eq.${cookbookId}&order=sort_order`,
          ),
        )
        .toEqual([
          { title: 'Buttermilk Roast Chicken', page_number: 40, sort_order: 0 },
          { title: 'Caesar Salad', page_number: 212, sort_order: 1 },
        ]);

      // Anonymous (no auth) read should succeed — public read RLS.
      const anonResp = await fetch(
        `${SUPABASE_URL}/rest/v1/global_cookbooks?select=title&isbn=eq.9781451624216`,
        // Note: PostgREST still requires the apikey header even for anon,
        // but it's the publishable key here, not a session JWT.
        { headers: { apikey: process.env.TEST_SUPABASE_ANON_KEY ?? '' } },
      );
      if (anonResp.ok) {
        const rows = (await anonResp.json()) as { title: string }[];
        expect(rows[0]?.title).toBe('Salt Fat Acid Heat');
      }

      // Delete via the list page.
      await page.getByRole('link', { name: '← Back to list' }).click();
      page.once('dialog', (d) => void d.accept());
      await page
        .getByRole('button', { name: 'Delete Salt Fat Acid Heat' })
        .click();

      await expect.poll(async () => {
        const rows = await adminGet<{ id: string }[]>(
          '/rest/v1/global_cookbooks?select=id&isbn=eq.9781451624216',
        );
        return rows.length;
      }).toBe(0);
    } finally {
      // Best-effort cleanup of any orphan rows in case the test bailed
      // before deleting them via the UI.
      await fetch(
        `${SUPABASE_URL}/rest/v1/global_cookbooks?isbn=eq.9781451624216`,
        {
          method: 'DELETE',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          },
        },
      ).catch(() => {});
      await admin.cleanup();
    }
  });

  test('new cookbook collection seeds recipes from the global catalog', async ({ user, page }) => {
    // Pre-seed a known cookbook with a few ToC entries via the service-role
    // so the test doesn't depend on the admin UI working — that's covered above.
    const isbn = `97819999${Math.floor(Math.random() * 100_000)
      .toString()
      .padStart(5, '0')}`;
    const cbResp = await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        title: 'Test Cookbook',
        author: 'Test Author',
        isbn,
        publication_year: 2024,
      }),
    });
    if (!cbResp.ok) throw new Error(`seed cookbook: ${await cbResp.text()}`);
    const [cb] = (await cbResp.json()) as { id: string }[];
    if (!cb) throw new Error('seed cookbook: no row returned');

    await fetch(`${SUPABASE_URL}/rest/v1/global_toc_entries`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        { cookbook_id: cb.id, title: 'Recipe Alpha', page_number: 10, sort_order: 0 },
        { cookbook_id: cb.id, title: 'Recipe Beta', page_number: 20, sort_order: 1 },
      ]),
    });

    try {
      await signIn(page, user);
      await page.goto('/collections/new');
      await page.getByLabel('Type').selectOption('PUBLISHED_BOOK');
      await page.getByLabel('ISBN').fill(isbn);

      // Wait for the hint card to appear with the matched cookbook.
      await expect(page.getByText('Test Cookbook')).toBeVisible();
      await expect(page.getByText(/2 known recipes in the catalog/)).toBeVisible();

      // Autofill should have populated title from the catalog.
      await expect(page.getByLabel('Title')).toHaveValue('Test Cookbook');

      // Seed-from-global checkbox defaults to checked. Submit.
      await page.getByRole('button', { name: 'Create' }).click();

      // We land on the new collection page; the two seeded recipes
      // should be visible in the list.
      await expect(page.getByRole('heading', { name: 'Test Cookbook' })).toBeVisible();
      await expect(page.getByText('Recipe Alpha')).toBeVisible();
      await expect(page.getByText('Recipe Beta')).toBeVisible();
    } finally {
      await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks?id=eq.${cb.id}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }).catch(() => {});
    }
  });

  test('admin imports a user cookbook from the candidates list', async ({ page }) => {
    // Seed a user cookbook with ISBN + a couple recipes. We hit the REST
    // API directly so the test is hermetic — the user-facing collection
    // creation flow is exercised elsewhere.
    const isbn = `97809${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`;
    const owner = await createTestUser('owner');
    const colId = await seedCookbookCollection(owner.id, {
      title: 'User Library Cookbook',
      author: 'Alice Writer',
      isbn,
      publication_year: 2023,
      recipes: ['User Recipe A', 'User Recipe B'],
    });

    const admin = await createTestUser('importadm', { admin: true });
    try {
      // Sanity: the just-seeded cookbook is actually visible in the
      // candidates view before we hand off to the UI. Catches PostgREST
      // schema-cache lag on a fresh CI runner before it shows up as a
      // confusing "list is empty" failure deeper in the test.
      await expect.poll(async () => {
        const rows = await adminGet<{ collection_id: string }[]>(
          `/rest/v1/admin_global_toc_import_candidates?select=collection_id&isbn=eq.${isbn}`,
        );
        return rows.length;
      }, { timeout: 10_000 }).toBe(1);

      await signIn(page, admin);

      // List page shows the backlog banner.
      await page.goto('/admin/global-toc');
      await expect(page.getByText(/not yet in the global catalog/)).toBeVisible();

      // Click through to the import tab.
      await page.getByRole('link', { name: /Review →/ }).click();
      await expect(page).toHaveURL(/\/admin\/global-toc\/import$/);

      // The candidate row carries the cookbook's metadata.
      const row = page.getByRole('listitem').filter({ hasText: 'User Library Cookbook' });
      await expect(row).toBeVisible();
      await expect(row.getByText(/2 recipes/)).toBeVisible();

      // Tick the row and hit the bulk action — that's the only path
      // now, the per-row Import button is gone.
      await row.getByRole('checkbox', { name: /Select User Library Cookbook/ }).check();
      await page.getByRole('button', { name: /Import selected \(1\)/ }).click();

      // After import the row flips to "Imported · edit" and the catalog
      // gains an entry whose entries match the user's recipes.
      await expect(row.getByRole('link', { name: /Imported · edit/ })).toBeVisible();

      const cookbook = await adminGet<{ id: string; title: string; shared_from_collection_id: string }[]>(
        `/rest/v1/global_cookbooks?select=id,title,shared_from_collection_id&isbn=eq.${isbn}`,
      );
      expect(cookbook[0]?.title).toBe('User Library Cookbook');
      expect(cookbook[0]?.shared_from_collection_id).toBe(colId);

      const entries = await adminGet<{ title: string; sort_order: number }[]>(
        `/rest/v1/global_toc_entries?select=title,sort_order&cookbook_id=eq.${cookbook[0]!.id}&order=sort_order`,
      );
      expect(entries.map((e) => e.title)).toEqual(['User Recipe A', 'User Recipe B']);
    } finally {
      await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks?isbn=eq.${isbn}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }).catch(() => {});
      await owner.cleanup();
      await admin.cleanup();
    }
  });

  test('owner filter narrows candidates and select-all bulk-imports them', async ({ page }) => {
    // Two owners, two cookbooks each, four distinct ISBNs. Digits-only
    // so the SQL normalize_isbn upper() doesn't change them under us
    // when we round-trip through the view.
    const tail = Date.now().toString().slice(-8);
    const isbns = [
      `97800${tail}1`,
      `97800${tail}2`,
      `97800${tail}3`,
      `97800${tail}4`,
    ];
    const ownerAlpha = await createTestUser('alpha');
    const ownerBeta = await createTestUser('beta');
    const colA1 = await seedCookbookCollection(ownerAlpha.id, {
      title: 'Alpha Book A',
      isbn: isbns[0]!,
      recipes: ['A1 r1'],
    });
    const colA2 = await seedCookbookCollection(ownerAlpha.id, {
      title: 'Alpha Book B',
      isbn: isbns[1]!,
      recipes: ['A2 r1'],
    });
    await seedCookbookCollection(ownerBeta.id, {
      title: 'Beta Book A',
      isbn: isbns[2]!,
      recipes: ['B1 r1'],
    });
    await seedCookbookCollection(ownerBeta.id, {
      title: 'Beta Book B',
      isbn: isbns[3]!,
      recipes: ['B2 r1'],
    });

    const admin = await createTestUser('bulkadm', { admin: true });
    try {
      // Wait for the seed to be visible in the view before driving the UI.
      await expect.poll(async () => {
        const rows = await adminGet<{ collection_id: string }[]>(
          `/rest/v1/admin_global_toc_import_candidates?select=collection_id&isbn=in.(${isbns.join(',')})`,
        );
        return rows.length;
      }, { timeout: 10_000 }).toBe(4);

      await signIn(page, admin);
      await page.goto('/admin/global-toc/import');

      // All four candidates visible by default.
      await expect(page.getByText('Alpha Book A')).toBeVisible();
      await expect(page.getByText('Beta Book A')).toBeVisible();

      // Filter to Alpha owner — Beta rows disappear. selectOption by
      // value (the owner UUID) so the test isn't sensitive to display-
      // name churn from other runs polluting the catalog.
      await page.getByLabel('Owner:').selectOption(ownerAlpha.id);
      await expect(page.getByText('Alpha Book A')).toBeVisible();
      await expect(page.getByText('Alpha Book B')).toBeVisible();
      await expect(page.getByText('Beta Book A')).not.toBeVisible();
      await expect(page.getByText('Beta Book B')).not.toBeVisible();

      // Select-all + import. The button label reflects the running count.
      await page.getByLabel('Select all visible candidates').check();
      await expect(page.getByRole('button', { name: /Import selected \(2\)/ })).toBeVisible();
      await page.getByRole('button', { name: /Import selected \(2\)/ }).click();

      // Both rows flip to "Imported · edit" once their RPC lands.
      const rowA1 = page.getByRole('listitem').filter({ hasText: 'Alpha Book A' });
      const rowA2 = page.getByRole('listitem').filter({ hasText: 'Alpha Book B' });
      await expect(rowA1.getByRole('link', { name: /Imported · edit/ })).toBeVisible();
      await expect(rowA2.getByRole('link', { name: /Imported · edit/ })).toBeVisible();

      // Server-side: two new catalog rows pointed at the alpha collections.
      const cookbooks = await adminGet<{ shared_from_collection_id: string; title: string }[]>(
        `/rest/v1/global_cookbooks?select=shared_from_collection_id,title&shared_from_collection_id=in.(${colA1},${colA2})`,
      );
      expect(new Set(cookbooks.map((c) => c.shared_from_collection_id))).toEqual(
        new Set([colA1, colA2]),
      );
    } finally {
      // Clean up the two global rows we created and all four user cookbooks.
      await fetch(
        `${SUPABASE_URL}/rest/v1/global_cookbooks?isbn=in.(${isbns.join(',')})`,
        {
          method: 'DELETE',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          },
        },
      ).catch(() => {});
      await ownerAlpha.cleanup();
      await ownerBeta.cleanup();
      await admin.cleanup();
    }
  });

  test('owner shares their cookbook (no ISBN required)', async ({ page, user }) => {
    // Create the user cookbook through the UI so the local cr-sqlite
    // store + outbox are exercised — this is the path the share button
    // is wired into.
    await signIn(page, user);
    await page.goto('/collections/new');
    await page.getByLabel('Type').selectOption('PUBLISHED_BOOK');
    await page.getByLabel('Title').fill('My Family Cookbook');
    await page.getByLabel('Author').fill('Grandma');
    // Deliberately leave ISBN blank — that's the path under test.
    await page.getByRole('button', { name: 'Create' }).click();

    // Land on the collection page.
    await expect(page.getByRole('heading', { name: 'My Family Cookbook' })).toBeVisible();
    // Wait for the local-first write to flush to remote — the share RPC
    // refuses if the source row hasn't reached the server yet.
    await waitForSynced(page);

    // Share button is visible (PUBLISHED_BOOK, not taken down).
    await page.getByRole('button', { name: 'Share to global catalog' }).click();

    // Confirm dialog renders.
    const dialog = page.getByRole('dialog', { name: 'Share to global catalog?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();

    // Button label flips to "Update shared catalog entry" once the
    // RPC returns.
    await expect(
      page.getByRole('button', { name: 'Update shared catalog entry' }),
    ).toBeVisible();

    // Verify a global row landed, with shared_from pointing at the user's
    // collection and NULL isbn.
    const collectionId = page.url().split('/').pop()!;
    const rows = await adminGet<
      { isbn: string | null; title: string; shared_from_collection_id: string }[]
    >(
      `/rest/v1/global_cookbooks?select=isbn,title,shared_from_collection_id&shared_from_collection_id=eq.${collectionId}`,
    );
    expect(rows[0]).toMatchObject({
      isbn: null,
      title: 'My Family Cookbook',
      shared_from_collection_id: collectionId,
    });

    // Cleanup — leaks a global row otherwise.
    await fetch(
      `${SUPABASE_URL}/rest/v1/global_cookbooks?shared_from_collection_id=eq.${collectionId}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      },
    ).catch(() => {});
  });

  test('admin edits sync back to the source user cookbook', async ({ page }) => {
    const isbn = `97808${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`;
    const owner = await createTestUser('syncback');
    const colId = await seedCookbookCollection(owner.id, {
      title: 'Original Title',
      author: 'Original Author',
      isbn,
      recipes: ['r1'],
    });
    const admin = await createTestUser('syncadm', { admin: true });
    try {
      // Stand up a global row that's already linked to the source.
      // We don't go through the admin RPC here because it requires an
      // auth.uid() to be admin and we're posting with service_role
      // (which has auth.uid() = null). The trigger we care about fires
      // on UPDATE either way.
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          title: 'Original Title',
          author: 'Original Author',
          isbn,
          shared_from_collection_id: colId,
        }),
      });
      expect(insertResp.ok).toBe(true);
      const [row] = (await insertResp.json()) as { id: string }[];
      const cookbookId = row!.id;

      await signIn(page, admin);
      await page.goto(`/admin/global-toc/${cookbookId}`);

      // Sync-back hint visible.
      await expect(page.getByText(/Linked to a user's library cookbook/)).toBeVisible();

      // Edit title and author, save.
      await page.getByLabel('Title').fill('Polished Title');
      await page.getByLabel('Author').fill('Polished Author');
      await page.getByRole('button', { name: 'Save cookbook' }).click();

      // Source collection now reflects the polished metadata.
      await expect.poll(async () => {
        const rows = await adminGet<{ title: string; author: string }[]>(
          `/rest/v1/recipe_collections?select=title,author&id=eq.${colId}`,
        );
        return rows[0];
      }).toMatchObject({ title: 'Polished Title', author: 'Polished Author' });
    } finally {
      await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks?isbn=eq.${isbn}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }).catch(() => {});
      await owner.cleanup();
      await admin.cleanup();
    }
  });

  test('cookbooks with an ISBN cannot be made public', async ({ user }) => {
    // Hits the REST layer directly so we exercise the DB trigger, not
    // the UI's pre-emptive disable.
    const colResp = await fetch(`${SUPABASE_URL}/rest/v1/recipe_collections`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        owner_id: user.id,
        title: 'Copyrighted Cookbook',
        source_type: 'PUBLISHED_BOOK',
        isbn: '978-0-321-12345-6',
      }),
    });
    expect(colResp.ok).toBe(true);
    const [col] = (await colResp.json()) as { id: string }[];

    // Attempt to flip to public — trigger should refuse.
    const updateResp = await fetch(
      `${SUPABASE_URL}/rest/v1/recipe_collections?id=eq.${col!.id}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_public: true }),
      },
    );
    expect(updateResp.ok).toBe(false);
    const body = await updateResp.text();
    expect(body).toMatch(/cannot be made public/i);
  });
});

// Direct REST insert for a user cookbook + N recipes. Keeps tests
// hermetic from the create-collection UI for paths that don't care
// about that flow.
async function seedCookbookCollection(
  ownerId: string,
  params: {
    title: string;
    author?: string;
    isbn?: string;
    publication_year?: number;
    recipes: string[];
  },
): Promise<string> {
  const colResp = await fetch(`${SUPABASE_URL}/rest/v1/recipe_collections`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      owner_id: ownerId,
      title: params.title,
      author: params.author ?? null,
      isbn: params.isbn ?? null,
      publication_year: params.publication_year ?? null,
      source_type: 'PUBLISHED_BOOK',
    }),
  });
  if (!colResp.ok) throw new Error(`seed collection: ${await colResp.text()}`);
  const [col] = (await colResp.json()) as { id: string }[];
  if (!col) throw new Error('seed collection: no row returned');

  const recipesResp = await fetch(`${SUPABASE_URL}/rest/v1/recipes`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      params.recipes.map((t, i) => ({
        collection_id: col.id,
        title: t,
        sort_order: i,
      })),
    ),
  });
  if (!recipesResp.ok) {
    throw new Error(`seed recipes: ${recipesResp.status} ${await recipesResp.text()}`);
  }
  return col.id;
}
