import { Link } from 'react-router-dom';

// Shown at `/` when no user is signed in. The router renders `LibraryPage`
// instead for authenticated users — see App.tsx's `<RootRoute />` wrapper.
export function LandingPage() {
  return (
    <div className="space-y-12">
      <section className="space-y-4 pt-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Your cookbook library, with you everywhere.
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-stone-600">
          CookYourBooks keeps every recipe — your own notes, cookbooks, web bookmarks — in one
          searchable, offline-first library that syncs across your phone and browser.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            to="/sign-up"
            className="rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
          >
            Create an account
          </Link>
          <Link
            to="/sign-in"
            className="rounded-md border border-stone-300 px-5 py-2.5 text-sm font-medium text-stone-800 hover:bg-stone-100"
          >
            Sign in
          </Link>
          <Link
            to="/discover"
            className="rounded-md px-5 py-2.5 text-sm font-medium text-stone-700 hover:text-stone-900"
          >
            Browse public recipes →
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Feature title="Snap a recipe, import it">
          Photograph a page of a cookbook or a handwritten card. A vision model parses the title,
          servings, ingredients, and steps directly into an editable recipe — configure your LLM
          provider once under Settings.
        </Feature>
        <Feature title="Offline-first, across devices">
          Every reading and write hits a local SQLite store first. Supabase Realtime pushes
          changes between your browser and your phone; offline edits flush when you reconnect.
        </Feature>
        <Feature title="Scale, convert, shop">
          Side-by-side scaling, ingredient-aware unit conversion with your own overrides, and a
          shopping list that aggregates across recipes and survives reloads.
        </Feature>
        <Feature title="Cook mode">
          Big typography, swipe/keyboard navigation, screen-wake lock, and haptic taps on device.
          Perfect for a messy phone on the counter.
        </Feature>
        <Feature title="Shareable collections">
          Mark a collection public and anyone can discover and fork it — a one-click copy into
          their own private library.
        </Feature>
        <Feature title="Open & exportable">
          Your data is your data. Export a recipe to Markdown, share it via your phone's share
          sheet, or sign out and take it elsewhere.
        </Feature>
      </section>

      <section className="rounded-lg border border-amber-200 bg-amber-50 p-8">
        <h2 className="text-2xl font-semibold tracking-tight text-stone-900">
          Free as in sourdough starter, not as in beer.
        </h2>
        <div className="mt-3 space-y-3 text-stone-700">
          <p>
            CookYourBooks is open source under the AGPL. Fork it, feed it, pass it on. The
            recipe for the app itself is right there in the jar — take a scoop, add your own
            flour, bake something new. If you run a modified copy for others, share what you
            changed so the next cook can keep it alive.
          </p>
          <p className="text-sm text-stone-600">
            Self-host it against your own Supabase project, read the code before you trust it
            with your grandmother's brisket, or send a patch when something bugs you.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href="https://github.com/jon-bell/CookYourBooks"
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
            target="_blank"
            rel="noreferrer"
          >
            View on GitHub
          </a>
          <a
            href="https://github.com/jon-bell/CookYourBooks/blob/main/CONTRIBUTING.md"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100"
            target="_blank"
            rel="noreferrer"
          >
            Contributing
          </a>
          <a
            href="https://github.com/jon-bell/CookYourBooks/blob/main/LICENSE"
            className="rounded-md px-4 py-2 text-sm font-medium text-stone-700 hover:text-stone-900"
            target="_blank"
            rel="noreferrer"
          >
            AGPL-3.0 →
          </a>
        </div>
      </section>

      <section className="rounded-lg border border-stone-200 bg-white p-6 text-sm text-stone-600">
        <p>
          Built as a local-first web app with a Capacitor wrapper for iOS + Android. Backed by
          Supabase for auth, sync, and storage — your keys and your recipes stay yours.
        </p>
      </section>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-stone-600">{children}</p>
    </div>
  );
}
