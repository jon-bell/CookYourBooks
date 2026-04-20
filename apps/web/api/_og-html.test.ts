import { describe, expect, it } from 'vitest';
import { buildOgImageUrl, cleanDescription, renderOgHtml } from './_og-html.js';

describe('renderOgHtml', () => {
  it('emits OG + Twitter tags with escaped user content', () => {
    const html = renderOgHtml({
      kind: 'recipe',
      title: 'Mom\'s "Secret" <Sauce>',
      description: 'A recipe & a story',
      url: 'https://cookyourbooks.app/collections/abc/recipes/xyz',
      subtitle: 'Family Favorites',
    });

    // Title is escaped everywhere it appears — no raw quotes, brackets,
    // or ampersands slip through into attribute values.
    expect(html).toContain('<title>Mom&#39;s &quot;Secret&quot; &lt;Sauce&gt;</title>');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('content="Mom&#39;s &quot;Secret&quot; &lt;Sauce&gt;"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('property="og:type" content="article"');
    expect(html).toContain('https://cookyourbooks.app/api/og-image');
    // No raw < or > slipped in except as tag delimiters.
    expect(html).not.toMatch(/<Sauce>/);
  });

  it('uses og:type "website" for non-recipe kinds', () => {
    const html = renderOgHtml({
      kind: 'collection',
      title: 'Breads',
      description: 'All my bread recipes.',
      url: 'https://cookyourbooks.app/collections/abc',
    });
    expect(html).toContain('property="og:type" content="website"');
  });

  it('honors an explicit imageUrl override', () => {
    const meta = {
      kind: 'recipe' as const,
      title: 'T',
      description: 'D',
      url: 'U',
      imageUrl: 'https://cdn.example.com/custom.png',
    };
    expect(buildOgImageUrl(meta)).toBe('https://cdn.example.com/custom.png');
  });

  it('falls back to /api/og-image with encoded query params', () => {
    const meta = {
      kind: 'recipe' as const,
      title: 'Mom\'s Stew',
      description: '',
      url: 'U',
      subtitle: 'Comfort food',
    };
    const image = buildOgImageUrl(meta);
    expect(image).toContain('/api/og-image?');
    expect(image).toContain('kind=recipe');
    expect(image).toContain('title=Mom%27s+Stew');
    expect(image).toContain('subtitle=Comfort+food');
  });
});

describe('cleanDescription', () => {
  it('squashes whitespace and strips control characters', () => {
    expect(cleanDescription('  hello\t\n\u0001 world  ')).toBe('hello world');
  });

  it('truncates with an ellipsis when over the limit', () => {
    const long = 'a'.repeat(210);
    const out = cleanDescription(long, 200);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for null / undefined / blank input', () => {
    expect(cleanDescription(null)).toBe('');
    expect(cleanDescription(undefined)).toBe('');
    expect(cleanDescription('   ')).toBe('');
  });
});
