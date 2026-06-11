import { useEffect, useRef } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { useAuth } from './auth/AuthProvider.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { SignInPage } from './auth/SignInPage.js';
import { SignUpPage } from './auth/SignUpPage.js';
import { LoadingState } from './components/LoadingState.js';
import { SyncBadge } from './components/SyncBadge.js';
import { useToast } from './components/ToastProvider.js';
import { UserMenu } from './components/UserMenu.js';
import { initShareIntent, type ShareIntentOutcome } from './import/shareIntent.js';
import { HelpDialog } from './keyboard/HelpDialog.js';
import { APP_SHORTCUTS, useKeyboardShortcuts } from './keyboard/shortcuts.js';
import { MobileNav } from './nav/MobileNav.js';
import { PRIMARY_NAV } from './nav/navItems.js';
import { ScrollTopButton } from './nav/ScrollTopButton.js';
import { useHardwareBack } from './nav/useHardwareBack.js';
import { useScrollRestoration } from './nav/useScrollRestoration.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { AdminGlobalTocPage } from './pages/AdminGlobalTocPage.js';
import { AdminNutritionPage } from './pages/AdminNutritionPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AllRecipesPage } from './pages/AllRecipesPage.js';
import { CollectionPage } from './pages/CollectionPage.js';
import { CookingTrackerPage } from './pages/CookingTrackerPage.js';
import { CookModePage } from './pages/CookModePage.js';
import { CookSessionPage } from './pages/CookSessionPage.js';
import { CostCenterPage } from './pages/CostCenterPage.js';
import { DiscoverPage } from './pages/DiscoverPage.js';
import { HouseholdJoinPage } from './pages/HouseholdJoinPage.js';
import { HouseholdPage } from './pages/HouseholdPage.js';
import { ImportBakeoffNewPage } from './pages/ImportBakeoffNewPage.js';
import { ImportBatchPage } from './pages/ImportBatchPage.js';
import { ImportGroupingPage } from './pages/ImportGroupingPage.js';
import { ImportItemPage } from './pages/ImportItemPage.js';
import { ImportLinkPage } from './pages/ImportLinkPage.js';
import { ImportListPage } from './pages/ImportListPage.js';
import { ImportNewPage } from './pages/ImportNewPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { LegalPage } from './pages/LegalPage.js';
import { LibraryPage } from './pages/LibraryPage.js';
import { NewCollectionPage } from './pages/NewCollectionPage.js';
import { RecentlyViewedPage } from './pages/RecentlyViewedPage.js';
import { RecipeEditorPage } from './pages/RecipeEditorPage.js';
import { RecipePage } from './pages/RecipePage.js';
import { ScanPagesPage } from './pages/ScanPagesPage.js';
import { SearchPage } from './pages/SearchPage.js';
import { SettingsCliPage } from './pages/SettingsCliPage.js';
import { SettingsConversionsPage } from './pages/SettingsConversionsPage.js';
import { SettingsDangerPage } from './pages/SettingsDangerPage.js';
import { SettingsLlmPage } from './pages/SettingsLlmPage.js';
import { SharedRecipePage } from './pages/SharedRecipePage.js';
import { ShoppingListPage } from './pages/ShoppingListPage.js';
import { SpeedImporterPage } from './pages/SpeedImporterPage.js';
import { TagBrowsePage } from './pages/TagBrowsePage.js';
import { ThemePicker } from './theme/ThemePicker.js';

export function App() {
  const { user } = useAuth();
  const { showHelp, closeHelp } = useKeyboardShortcuts(APP_SHORTCUTS);
  // Back returns to where you were; Android hardware back navigates the SPA.
  useScrollRestoration();
  useHardwareBack();
  return (
    <div className="min-h-full flex flex-col">
      <ShareIntentListener />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-[max(0.5rem,env(safe-area-inset-top))] focus:z-50 focus:rounded focus:bg-stone-900 focus:px-3 focus:py-1.5 focus:text-sm focus:text-white"
      >
        Skip to main content
      </a>
      <header className="border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-5xl py-3 flex flex-wrap items-center gap-x-6 gap-y-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            CookYourBooks
          </Link>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-4 text-sm text-stone-600 dark:text-stone-400 md:flex"
          >
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="hover:text-stone-900 dark:hover:text-stone-100 focus-visible:outline-offset-4"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && <SyncBadge />}
            <div className="hidden items-center gap-3 md:flex">
              <ThemePicker />
              {user ? (
                <UserMenu />
              ) : (
                <Link
                  to="/sign-in"
                  className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
                >
                  Sign in
                </Link>
              )}
            </div>
            <MobileNav />
          </div>
        </div>
      </header>
      <main id="main" className="flex-1 mx-auto w-full max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/sign-up" element={<SignUpPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          {/* Bare-uuid recipe share links. Deliberately NOT behind
              RequireAuth — RLS decides what (if anything) the visitor sees. */}
          <Route path="/r/:recipeId" element={<SharedRecipePage />} />
          <Route path="/" element={<RootRoute />} />
          <Route
            path="/library"
            element={
              <RequireAuth>
                <LibraryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/collections/new"
            element={
              <RequireAuth>
                <NewCollectionPage />
              </RequireAuth>
            }
          />
          <Route
            path="/collections/:collectionId"
            element={
              <RequireAuth>
                <CollectionPage />
              </RequireAuth>
            }
          />
          <Route
            path="/collections/:collectionId/recipes/new"
            element={
              <RequireAuth>
                <RecipeEditorPage mode="create" />
              </RequireAuth>
            }
          />
          <Route
            path="/collections/:collectionId/recipes/:recipeId"
            element={
              <RequireAuth>
                <RecipePage />
              </RequireAuth>
            }
          />
          <Route
            path="/collections/:collectionId/recipes/:recipeId/edit"
            element={
              <RequireAuth>
                <RecipeEditorPage mode="edit" />
              </RequireAuth>
            }
          />
          <Route
            path="/collections/:collectionId/recipes/:recipeId/cook"
            element={
              <RequireAuth>
                <CookModePage />
              </RequireAuth>
            }
          />
          <Route
            path="/recipes"
            element={
              <RequireAuth>
                <AllRecipesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/search"
            element={
              <RequireAuth>
                <SearchPage />
              </RequireAuth>
            }
          />
          <Route
            path="/shopping"
            element={
              <RequireAuth>
                <ShoppingListPage />
              </RequireAuth>
            }
          />
          <Route
            path="/cooking"
            element={
              <RequireAuth>
                <CookingTrackerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/cooking/recent"
            element={
              <RequireAuth>
                <RecentlyViewedPage />
              </RequireAuth>
            }
          />
          <Route
            path="/cooking/cook/:date"
            element={
              <RequireAuth>
                <CookSessionPage />
              </RequireAuth>
            }
          />
          <Route
            path="/tags"
            element={
              <RequireAuth>
                <TagBrowsePage />
              </RequireAuth>
            }
          />
          <Route
            path="/tags/:tag"
            element={
              <RequireAuth>
                <TagBrowsePage />
              </RequireAuth>
            }
          />
          <Route
            path="/import"
            element={
              <RequireAuth>
                <ImportListPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/new"
            element={
              <RequireAuth>
                <ImportNewPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/new/bakeoff"
            element={
              <RequireAuth>
                <ImportBakeoffNewPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/bakeoff"
            element={
              <RequireAuth>
                <ImportBakeoffNewPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/speed"
            element={
              <RequireAuth>
                <SpeedImporterPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/link"
            element={
              <RequireAuth>
                <ImportLinkPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/scan"
            element={
              <RequireAuth>
                <ScanPagesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/:batchId"
            element={
              <RequireAuth>
                <ImportBatchPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/:batchId/group"
            element={
              <RequireAuth>
                <ImportGroupingPage />
              </RequireAuth>
            }
          />
          <Route
            path="/import/:batchId/items/:itemId"
            element={
              <RequireAuth>
                <ImportItemPage />
              </RequireAuth>
            }
          />
          <Route path="/settings" element={<Navigate to="/settings/llm" replace />} />
          <Route
            path="/settings/llm"
            element={
              <RequireAuth>
                <SettingsLlmPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings/conversions"
            element={
              <RequireAuth>
                <SettingsConversionsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings/cli"
            element={
              <RequireAuth>
                <SettingsCliPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings/danger"
            element={
              <RequireAuth>
                <SettingsDangerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/household"
            element={
              <RequireAuth>
                <HouseholdPage />
              </RequireAuth>
            }
          />
          <Route path="/household/join" element={<HouseholdJoinPage />} />
          <Route
            path="/cost"
            element={
              <RequireAuth>
                <CostCenterPage />
              </RequireAuth>
            }
          />
          <Route
            path="/activity"
            element={
              <RequireAuth>
                <ActivityPage />
              </RequireAuth>
            }
          />
          <Route path="/legal/:doc" element={<LegalPage />} />
          <Route path="/legal" element={<LegalPage />} />
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <AdminPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/global-toc"
            element={
              <RequireAuth>
                <AdminGlobalTocPage mode="list" />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/global-toc/import"
            element={
              <RequireAuth>
                <AdminGlobalTocPage mode="import" />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/global-toc/:cookbookId"
            element={
              <RequireAuth>
                <AdminGlobalTocPage mode="editor" />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/nutrition"
            element={
              <RequireAuth>
                <AdminNutritionPage />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
      <HelpDialog open={showHelp} onClose={closeHelp} shortcuts={APP_SHORTCUTS} />
      <ScrollTopButton />
    </div>
  );
}

// Bridges the mobile share target into the router: when another app shares
// a supported video link to us, route to the import-from-link flow with the
// URL prefilled (it auto-extracts). Inert on the web — initShareIntent only
// wires up native Capacitor plugins.
//
// We always mount this (not gated on `user`) so a share that arrives
// during the auth-bootstrap window isn't dropped. A toast surfaces the
// outcome so the user gets feedback no matter what: success, unsupported
// platform, no URL, or not-signed-in. Replaces the previous "white
// screen of nothing" behavior on the share flow.
function ShareIntentListener() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();
  // useRef so the listener (which never re-registers) always reads the
  // current user without forcing the effect to re-run.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // If the user signs in after being bounced from a share, finish the
  // import flow by consuming the URL we stashed in sessionStorage.
  useEffect(() => {
    if (!user) return;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem('cookyourbooks.pendingShare');
      if (pending) sessionStorage.removeItem('cookyourbooks.pendingShare');
    } catch {
      /* private mode — nothing to do */
    }
    if (pending) {
      showToast('Resuming import after sign-in…', 'success');
      navigate(`/import/link?url=${encodeURIComponent(pending)}`);
    }
  }, [user, navigate, showToast]);

  useEffect(() => {
    return initShareIntent((outcome: ShareIntentOutcome) => {
      if (outcome.kind === 'import') {
        if (!userRef.current) {
          // Stash the URL so /sign-in can redirect into the import flow
          // post-login. Surface the wait reason so the user understands
          // why they're seeing the sign-in page after sharing.
          try {
            sessionStorage.setItem('cookyourbooks.pendingShare', outcome.url);
          } catch {
            /* private mode or quota — non-fatal */
          }
          showToast('Sign in to finish importing this recipe.', 'info');
          navigate('/sign-in');
          return;
        }
        const label =
          outcome.platform === 'youtube'
            ? 'YouTube'
            : outcome.platform === 'tiktok'
              ? 'TikTok'
              : outcome.platform === 'instagram'
                ? 'Instagram'
                : '';
        showToast(`Importing ${label ? `${label} ` : ''}recipe…`, 'success');
        navigate(`/import/link?url=${encodeURIComponent(outcome.url)}`);
        return;
      }
      // no_url — the share extension ran but we couldn't find a URL.
      showToast(
        "Couldn't read a link from that share. Try sharing the URL directly.",
        'warn',
        5000,
      );
    });
  }, [navigate, showToast]);

  return null;
}

// Branches on auth state so `/` is a marketing page for visitors and the
// all-recipes gallery for signed-in users (the collections Library lives at
// /library). We wait for the auth hydration to finish before deciding so a
// brief token refresh doesn't flash the landing page at a returning user.
function RootRoute() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingState surface="root" />;
  return user ? <AllRecipesPage /> : <LandingPage />;
}
