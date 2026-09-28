# `cyb` — CookYourBooks CLI

```bash
npm install -g @cookyourbooks/cli     # Node.js 20+; or: npx @cookyourbooks/cli <command>
cyb --help
```

The quickest start is **Settings → CLI tokens** in the app. Create a token
there and the page shows a ready-to-paste `cyb login` command with this
deployment's URL and anon key filled in.

From a checkout instead of npm:

```bash
pnpm --filter @cookyourbooks/cli build     # bundles to apps/cli/dist/index.js
alias cyb="node $PWD/apps/cli/dist/index.js"
```

The CLI has two kinds of commands, which authenticate differently.

## Library commands (CLI token)

`export`, `import`, and `toc …` call token-scoped RPCs with a `cyb_cli_*`
token minted in **Settings → CLI tokens**. The token is saved to
`~/.config/cookyourbooks/config.json` (mode 0600).

```bash
cyb login --url https://<ref>.supabase.co --anon-key <anon-key> --token cyb_cli_…
cyb whoami

# Back up the whole library, then restore recipes into a collection
cyb export --pretty -o library.json
cyb import library.json --collection <collection-uuid>

# Seed a cookbook's table of contents (one title per line)
cyb toc import titles.txt --collection <collection-uuid>
cyb toc export --format text
```

## Demo content (`cyb demo load`)

Loads the public-domain demo corpus (`scripts/demo-content/fetch.ts` writes it
to `scripts/demo-content/out/`) into an account **through the real OCR import
pipeline**. The pages are uploaded to Storage and queued as `import_batches` /
`import_items` exactly like the app's "Choose images" flow, and the account's
own OCR key and model do the reading. Clean drafts are then promoted with the
app's auto-accept bar (`isDraftAutoAcceptable` in `@cookyourbooks/domain`).

- One cookbook and one batch (`Demo · <title>`) per book.
- One import item per recipe. A recipe that crosses a page break is sent as
  one multi-image OCR call.
- **Only the named recipe is kept.** A recipe's pages usually also carry
  neighbouring recipes, often cut off at the page edge. The loader keeps the
  draft whose title matches the folder (`minestrone-alla-milanese` →
  "Vegetable Chowder (Minestrone alla Milanese)") and drops the rest. If none
  matches, the whole item stays on the board for review.
- **Page numbers come from the corpus** (`pages.json`, the Internet Archive's
  page map) when the scan has one. Models often mistake a recipe's number in
  the book for its page number.
- A draft that fails the auto-accept bar stays on the batch board under
  **Needs review**, as it would in the app.

These commands **sign in as the account** instead of using a CLI token,
because Storage uploads need a user session. The session exists only for the
run, and the password is read from an environment variable, never from a flag.
The account needs an OCR key saved (Settings → LLM & models); `--provider` /
`--model` override its saved model.

```bash
# 1. Fetch the corpus (page images only — the loader doesn't use the text)
deno run --allow-net --allow-read --allow-write --allow-run \
  scripts/demo-content/fetch.ts --images

# 2. See what would load
cyb demo load --dry-run                         # run from the repo root (default dir is relative)

# 3. Load it. URL / anon key fall back to the `cyb login` config.
export CYB_EMAIL=demo@example.com
read -rs CYB_PASSWORD && export CYB_PASSWORD
cyb demo load                                   # every book
cyb demo load --only italian-cook-book --max-recipes 4
cyb demo load --no-accept                       # leave results for review in the app
cyb demo load --no-wait                         # queue and exit; the worker finishes later
cyb demo load --fallback-model gemini-3.5-flash # retry pages Gemini refuses as "recitation"
```

Each batch gets a small `demo-manifest.json` in Storage beside its pages,
recording which recipe each import item was uploaded for. A later run resumes
from that record, so renaming or adding corpus folders doesn't re-pair items.
When resuming, `--fallback-model` also re-queues pages that were already
parked on a refusal.

Evaluating OCR prompts or models against real scans (nothing is filed):

```bash
# One item per page — how a person scans a book — with a candidate prompt,
# into its own labelled batch; compare the drafts on the batch board.
cyb demo load --only italian-cook-book --split-pages --no-accept \
  --prompt-file my-prompt.txt --model gemini-2.5-flash --label eval-flash
```

A run prints each upload and the OCR queue as it drains, then a summary:

```
The Italian Cook Book: The Art of Eating Well
  ↑ curled-omelet-frittata-in-riccioli (1 page)
  ↑ gnocchi (2 pages)
  uploaded 3/3 page images
  + batch bf180752-… (2 items) queued for OCR
  … 2 pending
  … 2 ocr_done

book                             queued  recipes  review  failed  pending
italian-cook-book                     2        2       0       0        0
```

**Re-running is safe.** A book whose batch already exists is resumed, not
uploaded again: the run waits for any pages still in the queue and promotes
what's ready. Promotion overwrites a same-titled recipe in the cookbook rather
than duplicating it. `--force` uploads the book again as a new batch.

**Local Supabase.** Serve the worker in mock mode (`OCR_MOCK_MODE=1`), register
`import_worker_config` in Vault (see the root `CLAUDE.md`), and seed an
`ocr_test_fixtures` row. The seeded `demo@cookyourbooks.local` / `demo1234`
account works once it has an OCR key (`ocr_key_set`) and prefs.

The App Store screenshot pipeline (`scripts/ios-screenshots/`) uses the same
corpus. `mobile.yml`'s `ios-screenshots` dispatch can run `cyb demo load`
first (`load_demo_library`), so the demo account is fully stocked before the
screenshots are taken.

## Releasing

Published to npm as [`@cookyourbooks/cli`](https://www.npmjs.com/package/@cookyourbooks/cli)
by `.github/workflows/cli-publish.yml`. To release, bump `version` in
`apps/cli/package.json`, commit, and push a matching tag:

```bash
git tag cli-v0.1.0 && git push origin cli-v0.1.0
```

The workflow typechecks, tests, installs the packed tarball into an empty
project as a smoke test, then publishes. Publishing is tokenless: it uses npm
trusted publishing (GitHub OIDC), so there's no `NPM_TOKEN` secret. The
package's npm settings trust `jon-bell/CookYourBooks` →
`.github/workflows/cli-publish.yml`, and provenance is attached automatically. The published
package is the single esbuild bundle (`dist/index.js`); the workspace packages
it uses (`@cookyourbooks/domain`, `@cookyourbooks/db`) are compiled into it, so
they're devDependencies and aren't published.
