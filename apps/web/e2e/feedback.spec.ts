import { adminGet, createTestUser } from './support/admin.js';
import { expect, signIn, test } from './support/fixtures.js';

interface FeedbackRow {
  id: string;
  owner_id: string;
  kind: string;
  body: string;
  route: string | null;
  platform: string | null;
  status: string;
  payload: {
    breadcrumbs?: { kind: string; label: string }[];
    device?: { platform?: string };
    consoleTail?: unknown[];
  } | null;
}

async function openFeedbackDialog(page: import('@playwright/test').Page) {
  // The desktop account menu opens it in place, over the current page.
  await page.locator('header').getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByRole('dialog', { name: 'Send feedback' })).toBeVisible();
}

test.describe('Feedback reports', () => {
  test('a report captures the breadcrumb trail that led to it', async ({
    authedPage: page,
    user,
  }) => {
    // Walk a route trail the report should remember.
    await page.goto('/library');
    await expect(page).toHaveURL(/\/library$/);
    await page.goto('/search');
    await expect(page).toHaveURL(/\/search$/);

    await openFeedbackDialog(page);
    await page
      .getByRole('dialog', { name: 'Send feedback' })
      .locator('textarea')
      .fill('Back from a recipe clears my search results.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Thanks — sent/)).toBeVisible({ timeout: 15_000 });

    const rows = await adminGet<FeedbackRow[]>(
      `/rest/v1/feedback_reports?owner_id=eq.${user.id}&select=*`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('bug');
    expect(row.body).toContain('clears my search results');
    expect(row.status).toBe('new');
    // Stamped server-side from the caller's auth, not the client payload.
    expect(row.owner_id).toBe(user.id);
    // Filed from /search, so that's where the user was.
    expect(row.route).toBe('/search');
    expect(row.platform).toBe('web');

    // The whole point: the trail travelled with it.
    const crumbs = row.payload?.breadcrumbs ?? [];
    const routes = crumbs.filter((c) => c.kind === 'route').map((c) => c.label);
    expect(routes).toContain('/library');
    expect(routes).toContain('/search');
    // And the click that opened the dialog was captured too.
    expect(crumbs.some((c) => c.kind === 'click' && /Send feedback/.test(c.label))).toBe(true);
  });

  test('a feature request is recorded as such and listed on /feedback', async ({
    authedPage: page,
    user,
  }) => {
    await page.goto('/feedback');
    await expect(page.getByText(/haven't sent any feedback yet/)).toBeVisible();

    await page.getByRole('button', { name: 'Send feedback' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await dialog.getByRole('radio', { name: 'Feature request' }).click();
    await dialog.locator('textarea').fill('Let me pin a collection to the top.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Thanks — sent/)).toBeVisible({ timeout: 15_000 });

    const rows = await adminGet<FeedbackRow[]>(
      `/rest/v1/feedback_reports?owner_id=eq.${user.id}&select=*`,
    );
    expect(rows[0]?.kind).toBe('feature');

    // The page lists it back to the user.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Let me pin a collection to the top.')).toBeVisible({
      timeout: 15_000,
    });
  });

  test("one user cannot read another user's reports", async ({ authedPage: page, user }) => {
    await openFeedbackDialog(page);
    await page
      .getByRole('dialog', { name: 'Send feedback' })
      .locator('textarea')
      .fill('Private report body, must not leak.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Thanks — sent/)).toBeVisible({ timeout: 15_000 });

    const mine = await adminGet<FeedbackRow[]>(
      `/rest/v1/feedback_reports?owner_id=eq.${user.id}&select=id`,
    );
    expect(mine).toHaveLength(1);

    // A second, unrelated (non-admin) user must see nothing on /feedback.
    const other = await createTestUser('otherfb');
    try {
      await signIn(page, other);
      await page.goto('/feedback');
      await expect(page.getByText(/haven't sent any feedback yet/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('Private report body, must not leak.')).toHaveCount(0);
    } finally {
      await other.cleanup();
    }
  });

  test("an admin can see and triage everyone's reports", async ({ authedPage: page, user }) => {
    await openFeedbackDialog(page);
    await page
      .getByRole('dialog', { name: 'Send feedback' })
      .locator('textarea')
      .fill('Report from a regular user.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Thanks — sent/)).toBeVisible({ timeout: 15_000 });

    const admin = await createTestUser('fbadmin', { admin: true });
    try {
      await signIn(page, admin);
      await page.goto('/admin/feedback');

      // The admin RLS branch lets them read another user's report.
      await expect(page.getByText('Report from a regular user.')).toBeVisible({ timeout: 15_000 });

      // And triage it.
      await page.getByRole('button', { name: 'Mark triaged' }).first().click();
      await expect
        .poll(
          async () => {
            const rows = await adminGet<FeedbackRow[]>(
              `/rest/v1/feedback_reports?owner_id=eq.${user.id}&select=status`,
            );
            return rows[0]?.status;
          },
          { timeout: 15_000 },
        )
        .toBe('triaged');

      // It leaves the default "new" filter once triaged.
      await page.getByRole('button', { name: 'new', exact: true }).click();
      await expect(page.getByText('Report from a regular user.')).toHaveCount(0);
    } finally {
      await admin.cleanup();
    }
  });
});
