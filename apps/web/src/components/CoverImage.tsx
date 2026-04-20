import { supabase } from '../supabase.js';

export function CoverImage({
  path,
  className,
  alt = 'Cover',
}: {
  path?: string;
  className?: string;
  alt?: string;
}) {
  if (!path) {
    return (
      <div
        className={`bg-gradient-to-br from-stone-100 to-stone-200 ${className ?? ''}`}
        aria-hidden
      />
    );
  }
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
