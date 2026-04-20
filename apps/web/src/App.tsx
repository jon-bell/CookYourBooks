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
import { DiscoverPage } from './pages/DiscoverPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SignInPage } from './auth/SignInPage.js';
import { SignUpPage } from './auth/SignUpPage.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { UserMenu } from './components/UserMenu.js';
import { SyncBadge } from './components/SyncBadge.js';
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
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-stone-900 focus:px-3 focus:py-1.5 focus:text-sm focus:text-white"
      >
        Skip to main content
      </a>
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            CookYourBooks
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-4 text-sm text-stone-600">
            <Link to="/" className="hover:text-stone-900 focus-visible:outline-offset-4">
              Library
            </Link>
            <Link to="/discover" className="hover:text-stone-900 focus-visible:outline-offset-4">
              Discover
            </Link>
            <Link to="/search" className="hover:text-stone-900 focus-visible:outline-offset-4">
              Search
            </Link>
            <Link to="/shopping" className="hover:text-stone-900 focus-visible:outline-offset-4">
              Shopping
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user && <SyncBadge />}
            {user ? (
              <UserMenu />
            ) : (
              <Link
                to="/sign-in"
                className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
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
  if (loading) return <div className="text-stone-500">Loading…</div>;
  return user ? <LibraryPage /> : <LandingPage />;
}
