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
// numbers* — the 1-based `page` that IA's search-inside returns and that
// `<id>_page_numbers.json` calls `leafNum` — not printed page numbers
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
  /** Human landing page, for attribution. */
  homepage: string;
  /** Whole-book transcriptions (Project Gutenberg etc.). */
  text?: { name: string; url: string }[];
  /** Internet Archive page scans, for the OCR import demo. */
  ia?: {
    identifier: string;
    recipes: ScannedRecipe[];
    bulk?: ScanRange[];
  };
  /** A born-digital PDF (federal cookbooks). Recipes are located by title. */
  pdf?: {
    url: string;
    recipes: PdfRecipe[];
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
      // No page map on this scan — leaves only.
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
];
