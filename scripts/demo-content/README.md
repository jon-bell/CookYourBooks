# Demo content

A public-domain recipe corpus for the demo account, App Store screenshots,
marketing, and hands-on testing of the import paths — real cookbooks, not
lorem-ipsum recipes, with no licensing question attached.

```bash
# everything (text + page images), ~145 MB
deno run --allow-net --allow-read --allow-write --allow-run scripts/demo-content/fetch.ts

# plus chapter-length page runs for the bulk OCR board, ~180 MB total
deno run --allow-net --allow-read --allow-write --allow-run scripts/demo-content/fetch.ts --bulk

# one book, text only
deno run --allow-net --allow-read --allow-write --allow-run scripts/demo-content/fetch.ts --only italian-cook-book --text
```

PDF sources need poppler (`pdftotext`, `pdftoppm`). Output lands in
`scripts/demo-content/out/` (gitignored). Re-runs are incremental.

## What's in it

| id | Book | Rights basis | Text | Page images |
| --- | --- | --- | --- | --- |
| `boston-cooking-school` | *The Boston Cooking-School Cook Book*, Fannie Farmer, 1896 | pre-1931 | [Gutenberg #65061](https://www.gutenberg.org/ebooks/65061) | [IA scan](https://archive.org/details/bostoncookingsc00collgoog) — 10 recipes + a breads chapter |
| `good-things-to-eat` | *Good Things to Eat*, Rufus Estes, 1911 | pre-1931 | [Gutenberg #18435](https://www.gutenberg.org/ebooks/18435) | [IA scan](https://archive.org/details/tx715_E8_1911) — 6 recipes |
| `italian-cook-book` | *The Italian Cook Book*, Maria Gentile, 1919 | pre-1931 | [Gutenberg #24407](https://www.gutenberg.org/ebooks/24407) | [IA scan](https://archive.org/details/italiancookbooka00gentiala) — 8 recipes + soups/pasta/rice chapter |
| `chinese-japanese-cook-book` | *Chinese-Japanese Cook Book*, Bosse & Watanna, 1914 | pre-1931 | [Gutenberg Canada](https://gutenberg.ca/ebooks/eaton-chinese/) | [IA scan](https://archive.org/details/chinesejapanesec00boss_1) — 8 recipes |
| `keep-the-beat-dinners` | *Keep the Beat: Deliciously Healthy Dinners*, NHLBI, 2009 | US gov work, 17 USC §105 | per-recipe `.txt` from the PDF | [PDF](https://www.nhlbi.nih.gov/resources/keep-beat-recipes-deliciously-healthy-dinners) — 12 recipes |
| `keep-the-beat-family-meals` | *Keep the Beat: Deliciously Healthy Family Meals*, NHLBI, 2010 | US gov work, 17 USC §105 | per-recipe `.txt` from the PDF | [PDF](https://www.nhlbi.nih.gov/resources/keep-beat-recipes-deliciously-healthy-family-meals) — 11 recipes |

### Contents and index pages

Every book above ships its contents pages (or its index, if it has no
contents) as page images, and the PDFs also as text. They're for demoing
"scan a book's contents to set up the cookbook":

| Book | Folder | Pages |
| --- | --- | --- |
| Fannie Farmer | `contents/` + `index/` | 22 contents + 32 index |
| Rufus Estes | `contents/` (at the back of the book) | 6 |
| Gentile | `index/`, numbered by recipe (there's no contents page) | 4 |
| Bosse & Watanna | `contents/` + `index/` | 1 + 7 |
| NHLBI Dinners / Family Meals | `contents/` (image + `.txt`) | 4 / 3 |

### Notes pages: blank and handwritten

These come from owners' copies of five more cookbooks. The printed book is
public domain, and the scans capture what an owner did with it: the blank
pages printed for your own recipes, and what people wrote on them.

| id | Book | `blank-notes/` | `handwritten/` / `pasted-in/` |
| --- | --- | --- | --- |
| `manuscript-receipt-book` | *The Manuscript Receipt Book and Household Treasury*, 1872 ([IA](https://archive.org/details/McGillLibrary-rbsc_manuscript-receipt-book_TX7156B57351874-18489)) | an unfilled ruled "Soups" section | copperplate potato soup, fish & white sauce, fancy cakes; `--bulk` adds the whole handwritten soups section |
| `gem-chopper-cook-book` | *Gem Chopper Cook Book*, 1902 ([IA](https://archive.org/details/gem-chopper-cook-book)) | a printed "My Own Recipes" grid page | the five grid pages the owner filled in pencil (cookies, cake, rocks…) |
| `cooks-friend` | *The Cook's Friend*, Middletown IN church cookbook, 1902 ([IA](https://archive.org/details/cooksfriend00cosm)) | a printed "MEMORANDA" page | a recipe on the front leaf, a notated slip laid in |
| `peerless-cook-book` | *The Peerless Cook Book*, Montreal church cookbook, 1890s ([IA](https://archive.org/details/peerlesscookbook00unse)) | — | three pages of handwritten recipes at the back (+ its contents) |
| `ylmia-cook-book` | *Y.L.M.I.A. Cook Book*, Blackfoot ID, 1926 ([IA](https://archive.org/details/ylmiacookbookthi00blac)) | a blank page | three pages of handwritten recipes, and a pasted-in newspaper recipe |

The NHLBI Dinners PDF adds two clean printed "Notes" pages
(`keep-the-beat-dinners/blank-notes/notes/`).

**Rights on the handwriting are separate from the book's.** Each owner's copy
records its position in `annotationRights`:

- An unpublished work by an unknown author is public domain in the US 120
  years after it was created. The *Manuscript Receipt Book* is in a period
  hand in an 1872 printing, so it is public domain. It's the one handwritten
  set that is safe to use anywhere.
- The other handwriting is undated and may be recent, especially the
  Y.L.M.I.A. book, printed in 1926. It's low risk: short recipe notes by
  anonymous owners in library scans. But it isn't provably public domain, so
  use it in-product and for OCR testing, not in marketing or App Store
  screenshots.

What each one is good for:

- **Fannie Farmer** popularised level measurements, so her quantities are clean
  (`1½ cups`, `¾ teaspoon salt`). Use her recipes for anything that shows off
  the parser, scaling or unit conversion.
- **Rufus Estes** was a Pullman dining-car chef, and this is one of the first
  cookbooks by an African-American author. His recipes are dense prose
  ("Beat one cupful of butter to a cream…"), which makes them a hard, honest
  test of OCR and ingredient extraction.
- **Gentile** and **Bosse & Watanna** add cuisine range, and the dishes still
  read as food people cook today (risotto, ravioli, foo yung, fried rice). The
  Italian scan is the most photogenic of the four, so use it for the OCR demo.
- **NHLBI** recipes are modern and plated, and they print nutrition facts
  (calories, sodium, fibre…). That makes them the screenshot set, and they
  double as a check on our nutrition panel's numbers.

## Output layout

```
out/<id>/
  source.json            provenance: title, author, year, rights, URLs, file index
  cover.jpg
  text/book.txt          whole-book transcription (Gutenberg)
  text/<recipe>.txt      one recipe from a PDF's text layer (NHLBI)
  pages/<recipe>/01-….jpg  the page(s) one recipe spans, in order → OCR import
  bulk/<chapter>/001-….jpg a chapter's worth of pages (--bulk) → bulk OCR board
  contents/, index/      table of contents / back index pages
  blank-notes/<label>/   printed pages meant for the owner's own recipes, left empty
  handwritten/<label>/   an owner's handwritten recipes or notes
  pasted-in/<label>/     a clipped recipe pasted into the book
```

In each `<kind>/<label>/` folder the page images are numbered in reading
order. PDF sections also get a `<kind>/<label>.txt` from the text layer.

## Adding recipes

Edit `sources.ts`. Scanned recipes are addressed by **Internet Archive leaf
number**, not by printed page. Find leaf numbers with:

```bash
deno run --allow-net scripts/demo-content/locate.ts italiancookbooka00gentiala '"risotto milanaise"' polenta
```

Pick the hit that is the recipe heading, not the index line. If the recipe
runs onto the next page, list both leaves. Then eyeball the images:
`fetch.ts` maps leaf numbers to IA's page-image index through each scan's
`scandata.xml`, because the offset between the two varies from scan to scan.

PDF recipes are found by the title printed at the top of the page. When a
title is artwork rather than text, pin its pages: `{ title, pages: [55] }`.

Contents, index and notes pages go in `sections` (the `span(from, to)` helper
builds a range). Search-inside finds printed headings ("CONTENTS",
"MEMORANDA"). Handwriting isn't in the OCR text layer, so find it by
eyeballing thumbnails: `https://archive.org/download/<id>/page/n<k>_w240.jpg`.
`k` there is the page-image index, not the leaf number. Convert it through
the scan's `scandata.xml` (the k-th page not marked
`addToAccessFormats=false`) before writing it into `sources.ts`.

## Rights rules for new sources

Add only material that is public domain in the US, and write the reason in
`rights`:

- **Published 1930 or earlier.** As of 2026-01-01, that is the US
  public-domain line. *Joy of Cooking* (1931) crosses it on 2027-01-01, but its
  name remains a trademark.
- **US federal government works** (17 USC §105): NIH/NHLBI, USDA, the
  military.

Rules of thumb:

- A bare ingredient list isn't copyrightable, but instruction prose and photos
  are. So "the recipe is on a blog" doesn't qualify.
- Don't add CC BY-SA sources (e.g. Wikibooks Cookbook). They are free, but not
  public domain, and attribution/share-alike would follow the demo content
  everywhere.
- Don't use `ToC/` (modern cookbook tables of contents) or any modern cover art.
- The historic books are fine for OCR demos. For polished screenshots, prefer
  the NHLBI set, or tidy the historic text first. Measures like "butter the
  size of an egg" make scaling look broken.

## Not yet wired up

- **USDA MyPlate Kitchen** (~1,000 public-domain recipes with nutrition data).
  USDA retired myplate.gov in January 2026, so the Wayback Machine now holds
  the canonical copy. Its CDX index was down when this was written; the
  recipes would be a `web` collection sourced through it.
- **Armed Forces Recipe Service, TM 10-412**
  ([IA](https://archive.org/details/tm-10-412-armed-forces-recipe-service-2003)).
  Every recipe card serves 100, which makes it the best scaling demo there is
  ("Chili Macaroni for 100 → for 4").
- A seeder that loads `out/` into a demo account. For now the content goes in
  through the app's own importers, which is itself part of the demo.
