// Dynamic Open Graph image renderer. Invoked as
//   /api/og-image?kind=recipe&title=Sourdough%20Loaf&subtitle=Bakery
// Returns a 1200×630 PNG suitable for og:image and twitter:image.
//
// Runs on Vercel's Edge runtime because @vercel/og compiles to
// WebAssembly (Satori + Resvg) and that combination doesn't boot in
// Node serverless.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

type Kind = 'recipe' | 'collection' | 'site';

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export default function handler(req: Request): Response {
  const url = new URL(req.url);
  const kindParam = (url.searchParams.get('kind') ?? 'site').toLowerCase();
  const kind: Kind =
    kindParam === 'recipe' || kindParam === 'collection' ? kindParam : 'site';
  const title = clamp(url.searchParams.get('title') ?? 'CookYourBooks', 80);
  const subtitle = clamp(url.searchParams.get('subtitle') ?? '', 120);

  // Humanize the kind label for the little eyebrow badge.
  const eyebrow =
    kind === 'recipe' ? 'Recipe' : kind === 'collection' ? 'Collection' : 'CookYourBooks';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          // Warm stone palette matching the app.
          background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 40%, #f5efe6 100%)',
          color: '#1c1917',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            fontSize: 28,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: '#78716c',
            fontWeight: 600,
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          <div
            style={{
              fontSize: title.length > 40 ? 72 : 96,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 36,
                color: '#44403c',
                lineHeight: 1.25,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 28,
            color: '#78716c',
          }}
        >
          <div style={{ fontWeight: 700, color: '#1c1917' }}>cookyourbooks.app</div>
          <div>Free as in sourdough starter</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      // Tell Vercel to cache the result — the inputs are in the URL so
      // identical params hit the cache. Title changes invalidate naturally.
      headers: {
        'cache-control': 'public, immutable, no-transform, max-age=31536000',
      },
    },
  );
}
