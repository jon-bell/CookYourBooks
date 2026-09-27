// The demo-content manifest: which public-domain books we pull, and which
// recipes inside them. `fetch.ts` reads this; nothing else does.
//
// Every entry must be public domain in the US, and `rights` says why:
//   - published 1930 or earlier (US public domain as of 2026-01-01), or
//   - a work of the US federal government (17 USC §105).
// Don't add anything that merely "looks free" (CC BY-SA, "free to
// download", fan-scanned modern books). The point of this set is that the
// demo account, App Store screenshots and marketing can use it without a
// licensing conversation.
//
// Scanned pages come from the Internet Archive. `leaves` are IA *leaf
// numbers* — the `page` that IA's search-inside returns and that the scan's
// scandata / page_numbers.json call `leafNum` — not printed page numbers
// (front matter, plates and Google cover sheets throw those off, and some
// scans have no page map at all). Find new ones with
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
 *                  "My Own Recipes", "Notes"), left empty
 *   handwritten  — an owner's handwritten recipes or notes
 *   pasted-in    — a clipped recipe pasted or tipped into the book
 */
export type SectionKind = 'contents' | 'index' | 'blank-notes' | 'handwritten' | 'pasted-in';

export interface Section {
  kind: SectionKind;
  /** Folder name under `<kind>/`. */
  label: string;
  /** IA leaf numbers (scans) or 1-based PDF page numbers (PDFs), in order. */
  leaves: number[];
}

/** Inclusive run of leaf / page numbers, for long contents and index runs. */
export const span = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * A recipe title as printed at the top of its page (case-insensitive) —
 * fetch.ts finds the page(s) from the PDF's text layer. When the title is
 * artwork rather than text, pin the 1-based PDF page numbers instead.
 */
export type PdfRecipe = string | { title: string; pages: number[] };

export interface Book {
  /** Folder name under the output dir. Stable — other tooling keys off it. */
  id: string;
  title: string;
  author: string;
  year: number;
  collection: CollectionKind;
  /** Why this is public domain. Shown in the README / source.json. */
  rights: string;
  /**
   * For copies carrying an owner's handwriting: the rights position on the
   * *annotations*, which is separate from the printed book's. See README.
   */
  annotationRights?: string;
  /** Human landing page, for attribution. */
  homepage: string;
  /** Whole-book transcriptions (Project Gutenberg etc.). */
  text?: { name: string; url: string }[];
  /** Internet Archive page scans, for the OCR import demo. */
  ia?: {
    identifier: string;
    recipes?: ScannedRecipe[];
    sections?: Section[];
    bulk?: ScanRange[];
  };
  /** A born-digital PDF (federal cookbooks). Recipes are located by title. */
  pdf?: {
    url: string;
    recipes: PdfRecipe[];
    sections?: Section[];
  };
}

export const BOOKS: Book[] = [
  {
    id: 'boston-cooking-school',
    title: 'The Boston Cooking-School Cook Book',
    author: 'Fannie Merritt Farmer',
    year: 1896,
    collection: 'cookbook',
    rights: 'Published 1896 — US public domain (pre-1931).',
    homepage: 'https://www.gutenberg.org/ebooks/65061',
    text: [
      { name: 'book.txt', url: 'https://www.gutenberg.org/cache/epub/65061/pg65061.txt' },
      { name: 'book.html', url: 'https://www.gutenberg.org/cache/epub/65061/pg65061-images.html' },
    ],
    ia: {
      // Google scan of the 1896 first edition (leaves numbered from 0).
      sections: [
        { kind: 'contents', label: 'contents', leaves: span(14, 35) },
        { kind: 'index', label: 'index', leaves: span(580, 611) },
      ],
      identifier: 'bostoncookingsc00collgoog',
      recipes: [
        { title: 'Boston Brown Bread', leaves: [95] }, // p. 60
        { title: 'Parker House Rolls', leaves: [96, 97] }, // pp. 61–62
        { title: 'Baking Powder Biscuit I', leaves: [105] }, // p. 70
        { title: 'Pop-overs', leaves: [111] }, // p. 76
        { title: 'Cream of Tomato Soup', leaves: [161] }, // p. 126
        { title: 'Clam Chowder', leaves: [163] }, // p. 128
        { title: 'Boston Baked Beans', leaves: [246, 247] }, // pp. 211–212
        { title: 'Apple Pie I', leaves: [432] }, // p. 389
        { title: 'Soft Molasses Gingerbread', leaves: [445, 446] }, // pp. 402–403
        { title: 'Chocolate Cake', leaves: [463] }, // p. 420
      ],
      bulk: [{ label: 'breads-biscuits-muffins', from: 95, to: 115 }],
    },
  },
  {
    id: 'good-things-to-eat',
    title: 'Good Things to Eat, as Suggested by Rufus',
    author: 'Rufus Estes',
    year: 1911,
    collection: 'cookbook',
    rights: 'Published 1911 — US public domain (pre-1931).',
    homepage: 'https://www.gutenberg.org/ebooks/18435',
    text: [
      { name: 'book.txt', url: 'https://www.gutenberg.org/cache/epub/18435/pg18435.txt' },
      { name: 'book.html', url: 'https://www.gutenberg.org/cache/epub/18435/pg18435-images.html' },
    ],
    ia: {
      // No page map on this scan — leaf numbers only. Contents at the back.
      sections: [{ kind: 'contents', label: 'contents', leaves: span(140, 145) }],
      identifier: 'tx715_E8_1911',
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
    rights: 'Published 1919 — US public domain (pre-1931).',
    homepage: 'https://www.gutenberg.org/ebooks/24407',
    text: [
      { name: 'book.txt', url: 'https://www.gutenberg.org/cache/epub/24407/pg24407.txt' },
      { name: 'book.html', url: 'https://www.gutenberg.org/cache/epub/24407/pg24407-images.html' },
    ],
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
    author: 'Sara Bosse and Onoto Watanna',
    year: 1914,
    collection: 'cookbook',
    rights: 'Published 1914 — US public domain (pre-1931).',
    homepage: 'https://gutenberg.ca/ebooks/eaton-chinese/eaton-chinese-00-h.html',
    text: [
      { name: 'book.txt', url: 'https://gutenberg.ca/ebooks/eaton-chinese/eaton-chinese-00-t.txt' },
      { name: 'book-html.zip', url: 'https://gutenberg.ca/ebooks/eaton-chinese/eaton-chinese-00-h-dir.zip' },
    ],
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
  {
    id: 'keep-the-beat-dinners',
    title: 'Keep the Beat Recipes: Deliciously Healthy Dinners',
    author: 'National Heart, Lung, and Blood Institute',
    year: 2009,
    collection: 'cookbook',
    rights:
      'US federal government work (NIH Publication No. 10-2921) — public domain under 17 USC §105. ' +
      '"Keep the Beat" is an HHS trademark: fine to credit, not to brand our screenshots with.',
    homepage: 'https://www.nhlbi.nih.gov/resources/keep-beat-recipes-deliciously-healthy-dinners',
    pdf: {
      url: 'https://www.nhlbi.nih.gov/sites/default/files/publications/10-2921.pdf',
      sections: [
        { kind: 'contents', label: 'contents', leaves: span(5, 8) },
        // Printed "Notes" pages at the back of the book.
        { kind: 'blank-notes', label: 'notes', leaves: [157, 158] },
      ],
      recipes: [
        'cocoa-spiced beef tenderloin with pineapple salsa',
        'stir-fried orange beef',
        'moroccan chicken stew with couscous',
        'thai-style chicken curry',
        'turkey club burger',
        'baja-style salmon tacos',
        'spanish-style shrimp stew',
        'pasta caprese',
        'classic macaroni and cheese',
        'red beans and rice',
        'corn and black bean burritos',
        'lentils with brown rice and kale',
      ],
    },
  },
  {
    id: 'keep-the-beat-family-meals',
    title: 'Keep the Beat Recipes: Deliciously Healthy Family Meals',
    author: 'National Heart, Lung, and Blood Institute',
    year: 2010,
    collection: 'cookbook',
    rights:
      'US federal government work (NIH Publication No. 10-7531) — public domain under 17 USC §105. ' +
      '"Keep the Beat" is an HHS trademark: fine to credit, not to brand our screenshots with.',
    homepage: 'https://www.nhlbi.nih.gov/resources/keep-beat-recipes-deliciously-healthy-family-meals',
    pdf: {
      url: 'https://www.nhlbi.nih.gov/sites/default/files/publications/10-7531.pdf',
      sections: [{ kind: 'contents', label: 'contents', leaves: span(5, 7) }],
      recipes: [
        'crunchy chicken fingers with tangy dipping sauce',
        'garden turkey meatloaf',
        'hawaiian huli huli chicken',
        'mexican lasagna',
        'turkey and beef meatballs with whole-wheat spaghetti',
        'pasta primavera',
        { title: 'oatmeal pecan waffles', pages: [55] }, // title is artwork
        'zesty tomato soup',
        'watermelon and tomato salad',
        'quinoa-stuffed tomatoes',
        'peanut butter hummus',
      ],
    },
  },

  // ── Owners' copies: blank notes pages and handwriting ────────────────────
  // Each of these is one specific library copy that an earlier owner wrote
  // in. No transcription exists (the handwriting is the point), so these
  // have no `text` or `recipes` entries — only `sections`.
  {
    id: 'manuscript-receipt-book',
    title: 'The Manuscript Receipt Book and Household Treasury',
    author: 'Dawson Brothers (publisher); unknown owner',
    year: 1872,
    collection: 'personal',
    rights: 'Published 1872 — US public domain (pre-1931).',
    annotationRights:
      'Handwriting by an unknown owner in a period hand, in an 1872 printing — an unpublished work of ' +
      'unknown authorship more than 120 years old, so public domain. The safest of the handwritten sets.',
    homepage: 'https://archive.org/details/McGillLibrary-rbsc_manuscript-receipt-book_TX7156B57351874-18489',
    ia: {
      // A printed blank book: a contents page plus a titled, ruled section
      // per course, sold for owners to fill in. This owner filled most of it.
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
    author: 'Sargent & Company (recipes by Janet McKenzie Hill)',
    year: 1902,
    collection: 'cookbook',
    rights: 'Published 1902 — US public domain (pre-1931).',
    annotationRights:
      'Pencil recipes by an unknown owner, undated (after 1902). Low-risk functional recipe text, ' +
      'but not provably public domain: use in-product and for OCR testing, not in marketing.',
    homepage: 'https://archive.org/details/gem-chopper-cook-book',
    ia: {
      // A promotional cookbook with a printed "My Own Recipes" grid page after
      // every few recipe pages. The owner pencilled recipes into the first five.
      identifier: 'gem-chopper-cook-book',
      sections: [
        { kind: 'handwritten', label: 'oatmeal-cookies', leaves: [19] },
        { kind: 'handwritten', label: 'cookies', leaves: [23] },
        { kind: 'handwritten', label: 'cake', leaves: [27] },
        { kind: 'handwritten', label: 'rocks', leaves: [33] },
        { kind: 'handwritten', label: 'molasses-cookies', leaves: [37] },
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
    rights: 'Published 1902 — US public domain (pre-1931).',
    annotationRights: 'Owner notes, undated (after 1902). Not provably public domain: in-product and OCR testing only.',
    homepage: 'https://archive.org/details/cooksfriend00cosm',
    ia: {
      // A church fundraiser cookbook, every recipe signed by its contributor,
      // with printed "MEMORANDA" pages between chapters.
      identifier: 'cooksfriend00cosm',
      sections: [
        { kind: 'blank-notes', label: 'memoranda', leaves: [44] },
        { kind: 'handwritten', label: 'front-leaf-recipe', leaves: [11] },
        { kind: 'handwritten', label: 'laid-in-slip', leaves: [171] },
      ],
    },
  },
  {
    id: 'peerless-cook-book',
    title: 'The Peerless Cook Book: A Compilation of Tested Recipes',
    author: "Ladies of St. James' Methodist Church, Montreal",
    year: 1890,
    collection: 'cookbook',
    rights: 'Published in the 1890s — US public domain (pre-1931).',
    annotationRights:
      'Handwritten recipes by an unknown owner, undated. Not provably public domain: in-product and OCR testing only.',
    homepage: 'https://archive.org/details/peerlesscookbook00unse',
    ia: {
      identifier: 'peerlesscookbook00unse',
      sections: [
        // This one keeps its contents at the back.
        { kind: 'contents', label: 'contents', leaves: span(95, 99) },
        { kind: 'handwritten', label: 'back-pages', leaves: span(100, 102) },
      ],
    },
  },
  {
    id: 'ylmia-cook-book',
    title: 'Y.L.M.I.A. Cook Book',
    author: "Young Ladies' Mutual Improvement Association, Blackfoot, Idaho",
    year: 1926,
    collection: 'cookbook',
    rights: 'Published 1926 — US public domain (pre-1931).',
    annotationRights:
      'Handwriting and a pasted clipping, undated (after 1926): likely still in copyright as unpublished ' +
      'work. In-product and OCR testing only; never in marketing or screenshots.',
    homepage: 'https://archive.org/details/ylmiacookbookthi00blac',
    ia: {
      // A community cookbook whose blank pages the owner used for their own
      // recipes, plus a newspaper recipe pasted onto one of them.
      identifier: 'ylmiacookbookthi00blac',
      sections: [
        { kind: 'contents', label: 'contents', leaves: [8] },
        { kind: 'blank-notes', label: 'blank-page', leaves: [38] },
        { kind: 'handwritten', label: 'specials', leaves: [62] },
        { kind: 'handwritten', label: 'cabbage-and-tomatoes', leaves: [63] },
        { kind: 'handwritten', label: 'steamed-pudding', leaves: [95] },
        { kind: 'pasted-in', label: 'ginger-cracker-cake-clipping', leaves: [59] },
      ],
    },
  },
];
