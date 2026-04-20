import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './env.js';

// Minimal admin helper — hits the GoTrue admin endpoints directly so we
// don't drag the Supabase JS client into the test bundle (Playwright runs
// under Node and we want minimal surface area).

interface AdminJson {
  [k: string]: unknown;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<AdminJson> {
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Admin API ${resp.status} on ${path}: ${text}`);
  }
  return text ? (JSON.parse(text) as AdminJson) : {};
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a freshly-confirmed user via the Supabase admin API. The returned
 * `cleanup` callback deletes the user (and cascades to their collections /
 * recipes via FK on delete cascade).
 *
 * Pass `{ admin: true }` to also insert a row in `public.admins` so the
 * user's admin-gated UI (`/admin`) unlocks on sign-in.
 */
export async function createTestUser(
  tag: string,
  opts: { admin?: boolean } = {},
): Promise<TestUser> {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `${tag}-${stamp}-${rand}@test.cookyourbooks.local`;
  const password = 'pw-' + rand + '-' + stamp;
  const created = (await adminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test ${tag}` },
    }),
  })) as { id?: string };
  if (!created.id) throw new Error(`admin create user returned no id: ${JSON.stringify(created)}`);
  const userId = created.id;

  if (opts.admin) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/admins`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: userId, note: `e2e:${tag}` }),
    });
    if (!resp.ok) {
      throw new Error(`admin grant failed: ${resp.status} ${await resp.text()}`);
    }
  }

  return {
    id: userId,
    email,
    password,
    cleanup: async () => {
      try {
        await adminFetch(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
      } catch {
        // Best-effort: a deleted user leaves no UI-visible trace, and
        // leaking one user per flaky teardown is tolerable in local dev.
      }
    },
  };
}

/** REST wrapper — useful in tests that need to assert remote state. */
export async function adminGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
  });
  if (!resp.ok) throw new Error(`Admin GET ${path} failed: ${resp.status}`);
  return (await resp.json()) as T;
}

/** Insert a public demo collection owned by the admin for Discover tests. */
export async function seedPublicCollection(params: {
  title: string;
  recipeTitles: string[];
}): Promise<{ collectionId: string; ownerId: string; cleanup: () => Promise<void> }> {
  const owner = await createTestUser('publisher');
  const colResp = await fetch(`${SUPABASE_URL}/rest/v1/recipe_collections`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      owner_id: owner.id,
      title: params.title,
      source_type: 'PERSONAL',
      is_public: true,
    }),
  });
  if (!colResp.ok) throw new Error(`seed collection: ${await colResp.text()}`);
  const [col] = (await colResp.json()) as { id: string }[];
  if (!col) throw new Error('seed collection: no row returned');

  for (let i = 0; i < params.recipeTitles.length; i += 1) {
    const t = params.recipeTitles[i]!;
    const rResp = await fetch(`${SUPABASE_URL}/rest/v1/recipes`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ collection_id: col.id, title: t, sort_order: i }),
    });
    if (!rResp.ok) throw new Error(`seed recipe: ${await rResp.text()}`);
  }

  return {
    collectionId: col.id,
    ownerId: owner.id,
    cleanup: async () => {
      await owner.cleanup();
    },
  };
}
