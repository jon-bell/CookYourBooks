import { Link, Route, Routes } from 'react-router-dom';
import { LibraryPage } from './pages/LibraryPage.js';
import { CollectionPage } from './pages/CollectionPage.js';
import { RecipePage } from './pages/RecipePage.js';
import { RecipeEditorPage } from './pages/RecipeEditorPage.js';
import { SearchPage } from './pages/SearchPage.js';
import { ShoppingListPage } from './pages/ShoppingListPage.js';
import { NewCollectionPage } from './pages/NewCollectionPage.js';
import { CookModePage } from './pages/CookModePage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AdminGlobalTocPage } from './pages/AdminGlobalTocPage.js';
import { DiscoverPage } from './pages/DiscoverPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ImportListPage } from './pages/ImportListPage.js';
import { ImportNewPage } from './pages/ImportNewPage.js';
import { ImportBatchPage } from './pages/ImportBatchPage.js';
import { ImportGroupingPage } from './pages/ImportGroupingPage.js';
import { ImportItemPage } from './pages/ImportItemPage.js';
import { ImportBakeoffNewPage } from './pages/ImportBakeoffNewPage.js';
import { SignInPage } from './auth/SignInPage.js';
import { SignUpPage } from './auth/SignUpPage.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { UserMenu } from './components/UserMenu.js';
import { SyncBadge } from './components/SyncBadge.js';
import { ThemePicker } from './theme/ThemePicker.js';
import { useAuth } from './auth/AuthProvider.js';
import { APP_SHORTCUTS, useKeyboardShortcuts } from './keyboard/shortcuts.js';
import { HelpDialog } from './keyboard/HelpDialog.js';

export function App() {
  const { user } = useAuth();
  const { showHelp, closeHelp } = useKeyboardShortcuts(APP_SHORTCUTS);
  return (
    <div className="min-h-full flex flex-col">
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
          <nav aria-label="Primary" className="flex items-center gap-4 text-sm text-stone-600 dark:text-stone-400">
            <Link to="/" className="hover:text-stone-900 dark:hover:text-stone-100 focus-visible:outline-offset-4">
              Library
            </Link>
            <Link to="/discover" className="hover:text-stone-900 dark:hover:text-stone-100 focus-visible:outline-offset-4">
              Discover
            </Link>
            <Link to="/search" className="hover:text-stone-900 dark:hover:text-stone-100 focus-visible:outline-offset-4">
              Search
            </Link>
            <Link to="/shopping" className="hover:text-stone-900 dark:hover:text-stone-100 focus-visible:outline-offset-4">
              Shopping
            </Link>
            <Link to="/import" className="hover:text-stone-900 dark:hover:text-stone-100 focus-visible:outline-offset-4">
              Import
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && <SyncBadge />}
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
        </div>
      </header>
      <main id="main" className="flex-1 mx-auto w-full max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/sign-up" element={<SignUpPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/" element={<RootRoute />} />
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
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
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
        </Routes>
      </main>
      <HelpDialog open={showHelp} onClose={closeHelp} shortcuts={APP_SHORTCUTS} />
    </div>
  );
}

// Branches on auth state so `/` is a marketing page for visitors and a
// library for signed-in users. We wait for the auth hydration to finish
// before deciding so a brief token refresh doesn't flash the landing page
// at a returning user.
function RootRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="text-stone-500 dark:text-stone-400">Loading…</div>;
  return user ? <LibraryPage /> : <LandingPage />;
}
