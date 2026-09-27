# Demo content

A rights-cleared recipe corpus for the demo account, App Store screenshots,
marketing, and hands-on testing of the import paths. These are real
cookbooks, not lorem-ipsum recipes. **Everything in it must be rights-cleared:
read [Rights](#rights) before adding anything.**

```bash
# everything (text + page images), ~80 MB
deno run --allow-net --allow-read --allow-write scripts/demo-content/fetch.ts

# plus chapter-length page runs for the bulk OCR board, ~110 MB total
deno run --allow-net --allow-read --allow-write scripts/demo-content/fetch.ts --bulk

# one book, text only
deno run --allow-net --allow-read --allow-write scripts/demo-content/fetch.ts --only italian-cook-book --text
```

Output lands in `scripts/demo-content/out/` (gitignored). Re-runs are
incremental. `out/` always mirrors the manifest: a full run deletes anything
`sources.ts` no longer lists, and a file is only reused if it came from the
URL the manifest names now. So a source removed for rights reasons can't
linger on anyone's disk.

## What's in it

| id | Book | Text | Page images |
| --- | --- | --- | --- |
| `boston-cooking-school` | *The Boston Cooking-School Cook Book*, Fannie Farmer, 1896 (1905 printing) | [Gutenberg #65061](https://www.gutenberg.org/ebooks/65061) | [LoC scan](https://archive.org/details/bostoncookingsch00farm_0): 10 recipes, contents, index, breads chapter |
| `good-things-to-eat` | *Good Things to Eat*, Rufus Estes, 1911 | [Gutenberg #18435](https://www.gutenberg.org/ebooks/18435) | [Newberry scan](https://archive.org/details/tx715_E8_1911): 6 recipes, contents |
| `italian-cook-book` | *The Italian Cook Book*, Maria Gentile, 1919 | [Gutenberg #24407](https://www.gutenberg.org/ebooks/24407) | [UC scan](https://archive.org/details/italiancookbooka00gentiala): 8 recipes, index, soups/pasta/rice chapter |
| `chinese-japanese-cook-book` | *Chinese-Japanese Cook Book*, Bosse & Watanna, 1914 | (none cleared) | [Alberta scan](https://archive.org/details/chinesejapanesec00boss_1): 8 recipes, contents, index |
| `manuscript-receipt-book` | *The Manuscript Receipt Book and Household Treasury*: **Margaret Blake's** handwritten recipe book, 1872 on | — | [McGill scan](https://archive.org/details/McGillLibrary-rbsc_manuscript-receipt-book_TX7156B57351874-18489): contents, an unfilled section, 3 handwritten recipes, the handwritten soups section |
| `gem-chopper-cook-book` | *Gem Chopper Cook Book*, 1902 | — | [owner's scan (PD Mark)](https://archive.org/details/gem-chopper-cook-book): a printed "My Own Recipes" page, index |
| `cooks-friend` | *The Cook's Friend*, 1902 | — | [LoC scan](https://archive.org/details/cooksfriend00cosm): a printed "MEMORANDA" page |

What each one is good for:

- **Fannie Farmer** popularised level measurements, so her quantities are clean
  (`1½ cups`, `¾ teaspoon salt`). Use her recipes for anything that shows off
  the parser, scaling or unit conversion.
- **Rufus Estes** was a Pullman dining-car chef, and this is one of the first
  cookbooks by an African-American author. His recipes are dense prose, which
  makes them a hard, honest test of OCR and ingredient extraction.
- **Gentile** and **Bosse & Watanna** add cuisine range, and the dishes still
  read as food people cook today (risotto, ravioli, foo yung, fried rice). The
  Italian scan is the most photogenic, so use it for the OCR demo.
- **Margaret Blake's receipt book** is a real family recipe book: a printed
  blank book (contents page, a ruled section per course) that she filled in
  copperplate over 16 years. It covers "scan grandma's recipe book", blank
  notes pages, and handwriting OCR, all rights-clear.
- **Gem Chopper** and **Cook's Friend** add more printed blank notes pages
  ("My Own Recipes", "MEMORANDA").

All of it is period material, so for polished screenshots tidy the text
first. Measures like "butter the size of an egg" make scaling look broken.

## Output layout

```
out/<id>/
  source.json              provenance: title, author, year, rights, scan terms, file index
  cover.jpg
  text/book.txt            whole-book transcription (PG header/footer stripped)
  pages/<recipe>/01-….jpg  the page(s) one recipe spans, in order → OCR import
  pages.json               printed page number per recipe leaf (IA's page map, when the scan has one)
  bulk/<chapter>/001-….jpg a chapter's worth of pages (--bulk) → bulk OCR board
  contents/, index/        table of contents / back index pages
  blank-notes/<label>/     printed pages meant for the owner's own recipes, left empty
  handwritten/<label>/     handwritten recipes (Blake only; see Rights)
```

## Rights

A source goes in only if **all** of these hold, and `sources.ts` records
why for each one (`rights`, `annotationRights`, `scanTerms`):

1. **Public domain in the US and in life+70 countries.** The demo content
   ships worldwide through the App Store. Concretely: published 1930 or
   earlier, **and** every author died before 1956 (or the work is
   anonymous and was published before 1956).
2. **The scan's digitizer allows any use, commercial included.** Never use a
   Google-digitized scan (IA identifiers ending `goog`, or a Google sheet as
   page 0): Google asks that its public-domain scans be used non-commercially.
   Each current scan's institution and its published terms are in `scanTerms`.
3. **Additions by an owner are cleared separately.** Handwriting, pasted-in
   clippings and notes are their own works, with their own author and date.
   They go in only if that author and date are known and clear (1) on their
   own. Blake qualifies: named author, died 1917, writing dated 1872–c.1890.
   Undated marginalia in other copies do not, so the pencilled "My Own
   Recipes" in the Gem Chopper copy and the notes in the Cook's Friend copy
   are deliberately left out.
4. **Transcriptions carry no license.** Project Gutenberg's license governs
   its trademark, not the public-domain text, so `fetch.ts` strips the
   header and footer, and refuses to write a file if it can't find them.
   Gutenberg Canada licenses commercial use of its ebooks, so it's not used.

Not accepted:

- **Government publications**, including US federal cookbooks (NHLBI,
  USDA MyPlate, the military's recipe service). Federal authorship doesn't
  clear third-party recipes and photography mixed into them.
- CC BY-SA and other "free but licensed" sources, `ToC/`, and modern cover art.

### Open item: the Internet Archive's site terms

Every scan here is downloaded from archive.org. The Archive's Terms of Use
say access to its collections "is granted for scholarship and research
purposes only". That's a contract term on using the site, not copyright. The
works are public domain, and a faithful scan of a public-domain page creates
no new copyright (US: *Bridgeman v. Corel*; EU: DSM Directive art. 14). But
it means commercial use of files fetched *from archive.org* isn't cleanly
cleared yet. Resolving it means either taking each scan from its digitizing
institution directly (Newberry, the Library of Congress, and University of
Alberta all publish open-use terms), or written permission from the Archive.
Until then, treat the page images as cleared for in-product demo and testing,
and check this item before using them in marketing.

## Adding recipes and pages

Edit `sources.ts`. Scanned pages are addressed by **Internet Archive leaf
number**, not by printed page. Find leaf numbers with:

```bash
deno run --allow-net scripts/demo-content/locate.ts italiancookbooka00gentiala '"risotto milanaise"' polenta
```

Pick the hit that is the recipe heading, not the index line. If the recipe
runs onto the next page, list both leaves. Then eyeball the images:
`fetch.ts` maps leaf numbers to IA's page-image index through each scan's
`scandata.xml`, because the offset between the two varies from scan to scan.

Contents, index and notes pages go in `sections` (the `span(from, to)` helper
builds a range). Search-inside finds printed headings ("CONTENTS",
"MEMORANDA"). Handwriting isn't in the OCR text layer, so find it by
eyeballing thumbnails: `https://archive.org/download/<id>/page/n<k>_w240.jpg`.
`k` there is the page-image index, not the leaf number. Convert it through
the scan's `scandata.xml` (the k-th page not marked
`addToAccessFormats=false`) before writing it into `sources.ts`.

## Not yet done

- A seeder that loads `out/` into a demo account. For now the content goes in
  through the app's own importers, which is itself part of the demo.
