// The demo-content manifest: which books we pull, and which recipes and
// pages inside them. `fetch.ts` reads this; nothing else does.
//
// EVERYTHING HERE MUST BE RIGHTS-CLEARED — see README "Rights" before adding
// anything. In short, every entry must be:
//   1. public domain in the US (published 1930 or earlier) AND in
//      life+70 countries (every author dead before 1956, or anonymous and
//      published before 1956) — the demo content ships worldwide via the
//      App Store; and
//   2. digitized by an institution whose terms allow any use, commercial
//      included — never a Google-digitized scan (Google asks for
//      non-commercial use only), and nothing whose provenance is unknown.
// Handwriting and other additions by a book's owner are a separate work
// with their own author and date; they're only in if *that* work clears.
// Government publications are not a shortcut: federal cookbooks mix in
// contractor- and third-party-supplied recipes and photos.
//
// Scanned pages come from the Internet Archive. `leaves` are IA *leaf
// numbers* — the `page` that IA's search-inside returns and that the scan's
// scandata / page_numbers.json call `leafNum` — not printed page numbers
// (front matter, plates and cover sheets throw those off, and some scans
// have no page map at all). Find new ones with
//   deno run --allow-net scripts/demo-content/locate.ts <identifier> "chop suey"
// The printed page is noted in a comment where the scan has one.

export type CollectionKind = 'cookbook' | 'web' | 'personal';

export interface ScannedRecipe {
  title: string;
  /** IA leaf numbers, in reading order. Two leaves = recipe crosses a page break. */
  leaves: number[];
}

export interface ScanRange {
  /** Folder name under `bulk/` — a chapter-sized run for the bulk OCR board. */
  label: string;
  from: number;
  to: number;
}

/**
 * Non-recipe pages worth having as examples:
 *   contents     — the book's table of contents (the "scan the contents to
 *                  build a cookbook" demo)
 *   index        — the back index, for books with no contents page
 *   blank-notes  — pages printed for the owner's own recipes ("Memoranda",
 *                  "My Own Recipes"), left empty
 *   handwritten  — an owner's handwritten recipes (only where the
 *                  handwriting itself is rights-cleared — see `annotationRights`)
 */
export type SectionKind = 'contents' | 'index' | 'blank-notes' | 'handwritten';

export interface Section {
  kind: SectionKind;
  /** Folder name under `<kind>/`. */
  label: string;
  /** IA leaf numbers, in reading order. */
  leaves: number[];
}

/** Inclusive run of leaf numbers, for long contents and index runs. */
export const span = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

export interface Book {
  /** Folder name under the output dir. Stable — other tooling keys off it. */
  id: string;
  title: string;
  author: string;
  year: number;
  collection: CollectionKind;
  /** Why the printed work is public domain, US and life+70. Recorded in source.json. */
  rights: string;
  /**
   * Required when the book carries an owner's handwriting: why *that* work
   * is public domain — its author, their dates, when it was written.
   */
  annotationRights?: string;
  /** Who digitized the scan, and the terms they publish for reuse. */
  scanTerms?: string;
  /** Human landing page, for attribution. */
  homepage: string;
  /**
   * Whole-book transcriptions. Project Gutenberg only — its license covers
   * the "Project Gutenberg" trademark, not the public-domain text, and
   * fetch.ts strips the header/footer that carry it. (Not Gutenberg Canada,
   * which licenses commercial use of its ebooks.)
   */
  text?: { name: string; url: string }[];
  /** Internet Archive page scans, for the OCR import demo. */
  ia?: {
    identifier: string;
    recipes?: ScannedRecipe[];
    sections?: Section[];
    bulk?: ScanRange[];
  };
}

const LOC_TERMS =
  'Digitized by the Library of Congress, which states it is "unaware of any copyright restrictions for this item."';

export const BOOKS: Book[] = [
  {
    id: 'boston-cooking-school',
    title: 'The Boston Cooking-School Cook Book',
    author: 'Fannie Merritt Farmer',
    year: 1896,
    collection: 'cookbook',
    rights: 'First published 1896; this scan is the 1905 printing. Farmer died 1915. Public domain US and life+70.',
    scanTerms: LOC_TERMS,
    homepage: 'https://www.gutenberg.org/ebooks/65061',
    text: [{ name: 'book.txt', url: 'https://www.gutenberg.org/cache/epub/65061/pg65061.txt' }],
    ia: {
      // Library of Congress copy of the 1905 printing. Same pagination as
      // 1896 (leaf = printed page + 34); adds an appendix and its index.
      // Not the Google scan of the 1896 edition: Google-digitized = non-commercial.
      identifier: 'bostoncookingsch00farm_0',
      sections: [
        { kind: 'contents', label: 'contents', leaves: span(13, 34) },
        { kind: 'index', label: 'index', leaves: span(681, 716) },
      ],
      recipes: [
        { title: 'Boston Brown Bread', leaves: [94] }, // p. 60
        { title: 'Parker House Rolls', leaves: [95, 96] }, // pp. 61–62
        { title: 'Baking Powder Biscuit I', leaves: [104] }, // p. 70
        { title: 'Pop-overs', leaves: [110] }, // p. 76
        { title: 'Cream of Tomato Soup', leaves: [160] }, // p. 126
        { title: 'Clam Chowder', leaves: [162] }, // p. 128
        { title: 'Boston Baked Beans', leaves: [245, 246] }, // pp. 211–212
        { title: 'Apple Pie I', leaves: [423] }, // p. 389
        { title: 'Soft Molasses Gingerbread', leaves: [436, 437] }, // pp. 402–403
        { title: 'Chocolate Cake', leaves: [454] }, // p. 420
      ],
      bulk: [{ label: 'breads-biscuits-muffins', from: 94, to: 114 }],
    },
  },
  {
    id: 'good-things-to-eat',
    title: 'Good Things to Eat, as Suggested by Rufus',
    author: 'Rufus Estes',
    year: 1911,
    collection: 'cookbook',
    rights: 'Published 1911. Estes died 1939. Public domain US and life+70.',
    scanTerms:
      'Digitized by the Newberry Library, which makes its collections available "for any lawful purpose, ' +
      'commercial or non-commercial, without licensing or permission fees" (newberry.org/rights-and-reproductions).',
    homepage: 'https://www.gutenberg.org/ebooks/18435',
    text: [{ name: 'book.txt', url: 'https://www.gutenberg.org/cache/epub/18435/pg18435.txt' }],
    ia: {
      // No page map on this scan — leaf numbers only. Contents at the back.
      identifier: 'tx715_E8_1911',
      sections: [{ kind: 'contents', label: 'contents', leaves: span(140, 145) }],
      recipes: [
        { title: 'Chicken Gumbo, Creole Style', leaves: [15, 16] },
        { title: 'Trianon Salad', leaves: [36] },
        { title: 'Fried Chicken', leaves: [41] },
        { title: 'Waffles, Southern Style', leaves: [83] },
        { title: 'Steamed Corn Bread', leaves: [87] },
        { title: 'Baltimore Cake', leaves: [95, 96] },
      ],
    },
  },
  {
    id: 'italian-cook-book',
    title: 'The Italian Cook Book: The Art of Eating Well',
    author: 'Maria Gentile',
    year: 1919,
    collection: 'cookbook',
    rights:
      'Published 1919 under the name "Maria Gentile" (identity unknown): anonymous/pseudonymous, so public ' +
      'domain 70 years after publication in life+70 countries (1990), and in the US (pre-1931).',
    scanTerms:
      'Digitized by the Internet Archive for University of California Libraries (MSN-sponsored, not Google); ' +
      'marked NOT_IN_COPYRIGHT, no reuse terms published.',
    homepage: 'https://www.gutenberg.org/ebooks/24407',
    text: [{ name: 'book.txt', url: 'https://www.gutenberg.org/cache/epub/24407/pg24407.txt' }],
    ia: {
      identifier: 'italiancookbooka00gentiala',
      // No contents page; the index is numbered by recipe, not page.
      sections: [{ kind: 'index', label: 'index', leaves: span(161, 164) }],
      recipes: [
        { title: 'Gnocchi', leaves: [11, 12] }, // pp. 7–8
        { title: 'Minestrone alla Milanese', leaves: [14, 15] }, // pp. 10–11
        { title: 'Ravioli', leaves: [15, 16] }, // pp. 11–12
        { title: 'Spaghetti or Macaroni with Butter and Cheese', leaves: [21] }, // p. 17
        { title: 'Risotto Milanaise', leaves: [26] }, // p. 22
        { title: 'Polenta Pie', leaves: [35, 36] }, // pp. 31–32
        { title: 'Curled Omelet (Frittata in riccioli)', leaves: [51] }, // p. 47
        { title: 'Zabaione', leaves: [150] }, // p. 146
      ],
      // Soups → macaroni → rice → polenta: a realistic "scan a chapter" run.
      bulk: [{ label: 'soups-pasta-rice', from: 9, to: 36 }],
    },
  },
  {
    id: 'chinese-japanese-cook-book',
    title: 'Chinese-Japanese Cook Book',
    author: 'Sara Bosse and Onoto Watanna (Winnifred Eaton)',
    year: 1914,
    collection: 'cookbook',
    rights:
      'Published 1914. Bosse died 1940, Eaton 1954 — public domain in life+70 countries since 2025, and in ' +
      'the US (pre-1931).',
    scanTerms:
      'Digitized by University of Alberta Library, which states "Public Domain items are free to reuse ' +
      'without restriction" (library.ualberta.ca/digital-initiatives/digital-collections/rights).',
    // No transcription: the only one is Gutenberg Canada's, which licenses commercial use.
    homepage: 'https://archive.org/details/chinesejapanesec00boss_1',
    ia: {
      identifier: 'chinesejapanesec00boss_1', // the 1914 first printing
      sections: [
        { kind: 'contents', label: 'contents', leaves: [9] },
        { kind: 'index', label: 'index', leaves: span(123, 129) },
      ],
      recipes: [
        { title: 'Noodle Soup', leaves: [22, 23] }, // pp. 12–13
        { title: 'Ten Sune Gune (Sweet and Sour Fish)', leaves: [30, 31] }, // pp. 20–21
        { title: 'Fried Rice with Chicken and Mushrooms', leaves: [49, 50] }, // pp. 39–40
        { title: 'Extra White Chop Suey', leaves: [51, 52] }, // pp. 41–42
        { title: 'Gai Yuk Chee Yuk (Chicken and Pork Chop Suey)', leaves: [54, 55] }, // pp. 44–45
        { title: 'Foo Yung Dan (Chinese Omelette with Herbs)', leaves: [64, 65] }, // pp. 54–55
        { title: 'Almond Cakes', leaves: [74] }, // p. 64
        { title: 'Amai Tamana (Sweet and Sour Cabbage)', leaves: [106, 107] }, // pp. 96–97
      ],
    },
  },

  // ── Owners' copies: printed notes pages, and cleared handwriting ─────────
  {
    id: 'manuscript-receipt-book',
    title: 'The Manuscript Receipt Book and Household Treasury',
    author: 'Margaret Blake (1835–1917); printed blank book by Dawson Brothers, Montreal',
    year: 1872,
    collection: 'personal',
    rights: 'The printed book (contents page, section headings): published 1872, public domain US and life+70.',
    annotationRights:
      "Margaret Blake's own recipe book: per McGill's catalogue record, written \"mainly by Margaret Blake in " +
      'Toronto over a period of 16 years" in this 1872 book, with some recipes by friends and family. Blake ' +
      'died 1917, so her unpublished writing is public domain (US: life+70, since 1988). The other hands are ' +
      'contemporaneous (1870s–1880s), unpublished and anonymous: public domain 120 years after creation.',
    scanTerms:
      'Digitized by McGill University Library, which publishes no reuse terms beyond copyright law ' +
      '(public-domain items are open access).',
    homepage: 'https://archive.org/details/McGillLibrary-rbsc_manuscript-receipt-book_TX7156B57351874-18489',
    ia: {
      // A printed blank book: a contents page plus a titled, ruled section
      // per course, sold for owners to fill in. Blake filled most of it.
      identifier: 'McGillLibrary-rbsc_manuscript-receipt-book_TX7156B57351874-18489',
      sections: [
        { kind: 'contents', label: 'contents', leaves: [10] },
        { kind: 'blank-notes', label: 'soups-unfilled', leaves: [22, 23] },
        { kind: 'handwritten', label: 'potato-soup', leaves: [15] },
        { kind: 'handwritten', label: 'fish-and-white-sauce', leaves: [28] },
        { kind: 'handwritten', label: 'fancy-cakes', leaves: [131] },
      ],
      // The whole handwritten soups section: a bulk OCR run on handwriting.
      bulk: [{ label: 'soups-handwritten', from: 14, to: 21 }],
    },
  },
  {
    id: 'gem-chopper-cook-book',
    title: 'Gem Chopper Cook Book',
    author: 'Sargent & Company (recipes by Janet McKenzie Hill, d. 1933)',
    year: 1902,
    collection: 'cookbook',
    rights: 'Published 1902. Hill died 1933. Public domain US and life+70.',
    scanTerms: "Scanned and uploaded by the book's owner under the Creative Commons Public Domain Mark 1.0.",
    homepage: 'https://archive.org/details/gem-chopper-cook-book',
    ia: {
      // A promotional cookbook with a printed "My Own Recipes" grid page after
      // every few recipe pages. This copy's owner pencilled recipes into some
      // of them — undated, unattributed, so NOT used; only an empty one is.
      identifier: 'gem-chopper-cook-book',
      sections: [
        { kind: 'blank-notes', label: 'my-own-recipes', leaves: [41] },
        { kind: 'index', label: 'index', leaves: [96] },
      ],
    },
  },
  {
    id: 'cooks-friend',
    title: "The Cook's Friend",
    author: 'The Cosmos Society of the M. E. Church, Middletown, Indiana',
    year: 1902,
    collection: 'cookbook',
    rights:
      'Published 1902, public domain in the US. Only a printed blank "MEMORANDA" page is used — no ' +
      "contributor's text — so the contributors' dates don't matter.",
    scanTerms: LOC_TERMS,
    homepage: 'https://archive.org/details/cooksfriend00cosm',
    ia: {
      // A church fundraiser cookbook with printed "MEMORANDA" pages between
      // chapters. (This copy's owner notes are undated — NOT used.)
      identifier: 'cooksfriend00cosm',
      sections: [{ kind: 'blank-notes', label: 'memoranda', leaves: [44] }],
    },
  },
];
