// Build a minimal HTML document with Open Graph / Twitter Card meta
// tags. Used by the UA-gated `api/og.ts` serverless function — link
// unfurlers (Slackbot, Twitterbot, iMessage's facebookexternalhit,
// etc.) scrape these tags and render a card.
//
// Regular browsers never hit this path because the vercel.json rewrite
// is gated on crawler user-agents. So we don't need to emit the SPA
// bootstrap here; bots only read the <head>.

const SITE_ORIGIN = 'https://cookyourbooks.app';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OgMeta {
  kind: 'recipe' | 'collection' | 'site';
  title: string;
  description: string;
  /** Fully-qualified canonical URL. */
  url: string;
  /**
   * Optional absolute URL to a cover image already stored elsewhere
   * (e.g. Supabase storage). When unset, we point at
   * `/api/og-image?title=…&subtitle=…` which renders a branded card.
   */
  imageUrl?: string;
  /** Short site-title-adjacent string rendered under the main title
   *  in the generated card (e.g. collection name on a recipe card). */
  subtitle?: string;
}

export function buildOgImageUrl(meta: OgMeta): string {
  if (meta.imageUrl) return meta.imageUrl;
  const qs = new URLSearchParams({
    kind: meta.kind,
    title: meta.title,
  });
  if (meta.subtitle) qs.set('subtitle', meta.subtitle);
  return `${SITE_ORIGIN}/api/og-image?${qs.toString()}`;
}

export function renderOgHtml(meta: OgMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const url = escapeHtml(meta.url);
  const image = escapeHtml(buildOgImageUrl(meta));
  const ogType = meta.kind === 'recipe' ? 'article' : 'website';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${url}" />

    <meta property="og:type" content="${ogType}" />
    <meta property="og:site_name" content="CookYourBooks" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />
  </head>
  <body>
    <h1>${title}</h1>
    <p>${description}</p>
    <p><a href="${url}">View on CookYourBooks</a></p>
  </body>
</html>
`;
}

/**
 * Public-facing text cleanup: squash whitespace, strip control chars,
 * clamp to a length reasonable for `og:description`. Input is untrusted
 * (user-generated recipe notes), but we always escape downstream so
 * this is a readability filter, not a security boundary.
 */
export function cleanDescription(raw: string | null | undefined, max = 200): string {
  if (!raw) return '';
  const squashed = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (squashed.length <= max) return squashed;
  return squashed.slice(0, max - 1).trimEnd() + '…';
}
