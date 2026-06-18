import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { coverSrcSet, transformedCoverUrl } from './coverUrl.js';

// Largest base `src` width per variant (the descriptor browsers fall back to
// when `sizes` can't be evaluated). Thumbs render small (cards ~330px CSS,
// 2x retina ≈ 640); full covers render up to ~400px CSS (recipe hero, editor).
const BASE_WIDTH = { thumb: 640, full: 960 } as const;

// `sizes` hint per variant — tells the browser the rendered CSS width so it
// can pick the smallest adequate `srcSet` entry. Thumbs cap at the gallery
// card width; full covers cap at the recipe hero's `max-w-md` (~448px).
const SIZES = {
  thumb: '(max-width: 640px) 50vw, 330px',
  full: '(max-width: 768px) 100vw, 448px',
} as const;

export function CoverImage({
  path,
  className,
  alt = 'Cover',
  variant = 'full',
}: {
  path?: string;
  className?: string;
  alt?: string;
  /** 'thumb' renders a smaller responsive width hint than 'full'. Both serve
   *  CDN-cached on-the-fly transforms of the same source object. */
  variant?: 'full' | 'thumb';
}) {
  // Track whether the transformed URL has errored so we can fall back to the
  // untransformed public URL once (e.g. a runtime/plan without the render
  // endpoint, or a format the transformer can't decode).
  const [transformFailed, setTransformFailed] = useState(false);

  // Reset the fallback flag whenever the path changes so a new cover attempt
  // starts with the transformed URL again.
  useEffect(() => {
    setTransformFailed(false);
  }, [path]);

  if (!path) {
    return (
      <div
        className={`bg-gradient-to-br from-stone-100 to-stone-200 ${className ?? ''}`}
        aria-hidden
      />
    );
  }

  if (transformFailed) {
    // One-time fallback: serve the original object untransformed. No `onError`
    // here guards against an infinite reload loop if the object is gone.
    const { data } = supabase.storage.from('covers').getPublicUrl(path);
    return (
      <img
        src={data.publicUrl}
        alt={alt}
        className={`object-cover ${className ?? ''}`}
        loading="lazy"
      />
    );
  }

  return (
    <img
      src={transformedCoverUrl(path, BASE_WIDTH[variant])}
      srcSet={coverSrcSet(path)}
      sizes={SIZES[variant]}
      alt={alt}
      className={`object-cover ${className ?? ''}`}
      loading="lazy"
      onError={() => setTransformFailed(true)}
    />
  );
}
