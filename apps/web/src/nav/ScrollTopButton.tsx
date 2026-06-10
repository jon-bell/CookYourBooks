import { useEffect, useState } from 'react';

const SHOW_AFTER_PX = 600;

/**
 * Floating back-to-top button for touch devices (long recipe lists / recipe
 * pages have no keyboard Home key on mobile). Coarse-pointer only — desktop
 * users have scrollbars and keyboards. Appears after the page has scrolled
 * a screen or so; sits above the safe-area inset.
 */
export function ScrollTopButton() {
  const [visible, setVisible] = useState(false);
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    setCoarse(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
    );
  }, []);

  useEffect(() => {
    if (!coarse) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setVisible(window.scrollY > SHOW_AFTER_PX);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [coarse]);

  if (!coarse || !visible) return null;
  return (
    <button
      type="button"
      aria-label="Scroll to top"
      data-testid="scroll-top-button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-stone-300 bg-white/90 text-lg text-stone-700 shadow-lg backdrop-blur dark:border-stone-600 dark:bg-stone-900/90 dark:text-stone-200"
    >
      <span aria-hidden>↑</span>
    </button>
  );
}
