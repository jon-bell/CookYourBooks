import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { thumbPathFor } from '../recipe/coverImage.js';

export function CoverImage({
  path,
  className,
  alt = 'Cover',
  variant = 'full',
}: {
  path?: string;
  className?: string;
  alt?: string;
  /** 'thumb' renders the `.thumb.jpg` sibling and falls back to the full image
   *  on error (old covers without a thumb). Defaults to 'full'. */
  variant?: 'full' | 'thumb';
}) {
  // Track whether the thumb has errored so we can fall back to the full image.
  const [thumbFailed, setThumbFailed] = useState(false);

  // Reset the fallback flag whenever the path changes so a new cover attempt
  // starts with the thumb again.
  useEffect(() => {
    setThumbFailed(false);
  }, [path]);

  if (!path) {
    return (
      <div
        className={`bg-gradient-to-br from-stone-100 to-stone-200 ${className ?? ''}`}
        aria-hidden
      />
    );
  }

  const displayPath =
    variant === 'thumb' && !thumbFailed ? thumbPathFor(path) : path;
  const { data } = supabase.storage.from('covers').getPublicUrl(displayPath);

  return (
    <img
      src={data.publicUrl}
      alt={alt}
      className={`object-cover ${className ?? ''}`}
      loading="lazy"
      onError={
        variant === 'thumb' && !thumbFailed
          ? () => setThumbFailed(true)
          : undefined
      }
    />
  );
}
