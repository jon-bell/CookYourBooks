import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionPickerOption } from '../local/repositories.js';

interface Props {
  options: readonly CollectionPickerOption[];
  /** Currently-selected cookbook id. Empty string means unassigned. */
  value: string;
  onChange: (id: string) => void;
  /** Trigger inline cookbook creation. Renders as the last option in
   *  the dropdown; on pick the parent flips into create mode. */
  onCreateNew?: () => void;
  loading?: boolean;
  /** When provided, matched recipe in the picked cookbook (so the user
   *  understands the save will UPDATE an existing recipe). */
  matchedExistingTitle?: string;
}

/**
 * Rich combobox for picking a target cookbook. Type to filter, ↑ / ↓ /
 * Enter to choose, Esc closes. Each option shows the cookbook title,
 * author (when present), and recipe count so a near-empty placeholder
 * is visually distinct from an established cookbook.
 */
export function CookbookCombobox({
  options,
  value,
  onChange,
  onCreateNew,
  loading = false,
  matchedExistingTitle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.id === value),
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.title.toLowerCase().includes(q) ||
        (o.author?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  // Including (unassigned) as a special always-present option at the
  // top of the list when the user has typed nothing.
  const showUnassigned = query.trim().length === 0;
  const optionCount = filtered.length + (showUnassigned ? 1 : 0) + (onCreateNew ? 1 : 0);
  const createIdx = onCreateNew ? optionCount - 1 : -1;
  const unassignedIdx = showUnassigned ? 0 : -1;
  const optionsStart = showUnassigned ? 1 : 0;

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  function pickIdx(idx: number) {
    if (idx === unassignedIdx) {
      onChange('');
    } else if (idx === createIdx) {
      onCreateNew?.();
    } else {
      const realIdx = idx - optionsStart;
      const opt = filtered[realIdx];
      if (opt) onChange(opt.id);
    }
    setOpen(false);
    setQuery('');
    setActiveIdx(0);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(optionCount - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickIdx(activeIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  // When the dropdown opens, autofocus the search input.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const summaryLabel = selected
    ? selected.title
    : '(unassigned)';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-stone-300 bg-white px-3 py-1.5 text-left text-sm hover:border-stone-500"
      >
        <span className="flex flex-col">
          <span className={selected ? 'font-medium text-stone-900' : 'text-stone-500'}>
            {summaryLabel}
          </span>
          {selected?.author && (
            <span className="text-[11px] text-stone-500">{selected.author}</span>
          )}
          {matchedExistingTitle && (
            <span className="text-[11px] font-medium text-emerald-700">
              → will update “{matchedExistingTitle}”
            </span>
          )}
        </span>
        <svg viewBox="0 0 12 8" className="ml-2 h-2.5 w-2.5 fill-current text-stone-400">
          <path d="M0 0h12L6 8z" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-stone-200 bg-white shadow-lg"
        >
          <div className="border-b border-stone-100 p-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onKey}
              placeholder="Search cookbooks…"
              className="w-full rounded border border-stone-200 px-2 py-1 text-sm outline-none focus:border-stone-500"
            />
          </div>
          <ul className="py-1 text-sm">
            {loading && filtered.length === 0 && (
              <li className="px-3 py-2 text-stone-500">Loading…</li>
            )}
            {!loading && filtered.length === 0 && !showUnassigned && !onCreateNew && (
              <li className="px-3 py-2 text-stone-500">No matches.</li>
            )}
            {showUnassigned && (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === ''}
                  onMouseEnter={() => setActiveIdx(unassignedIdx)}
                  onClick={() => pickIdx(unassignedIdx)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-stone-700 ${
                    activeIdx === unassignedIdx ? 'bg-stone-100' : 'hover:bg-stone-50'
                  }`}
                >
                  <span className="italic text-stone-500">(unassigned)</span>
                  {value === '' && <span className="text-xs text-stone-400">current</span>}
                </button>
              </li>
            )}
            {filtered.map((opt, i) => {
              const idx = optionsStart + i;
              const isActive = idx === activeIdx;
              const isCurrent = opt.id === value;
              return (
                <li key={opt.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => pickIdx(idx)}
                    className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left ${
                      isActive ? 'bg-stone-100' : 'hover:bg-stone-50'
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-stone-900">{opt.title}</span>
                      {opt.author && (
                        <span className="truncate text-[11px] text-stone-500">{opt.author}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px] text-stone-500">
                      <span>
                        {opt.recipeCount} {opt.recipeCount === 1 ? 'recipe' : 'recipes'}
                      </span>
                      {isCurrent && <span className="text-stone-400">·  current</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {onCreateNew && (
              <li className="border-t border-stone-100">
                <button
                  type="button"
                  role="option"
                  onMouseEnter={() => setActiveIdx(createIdx)}
                  onClick={() => pickIdx(createIdx)}
                  className={`w-full px-3 py-1.5 text-left font-medium text-stone-700 ${
                    activeIdx === createIdx ? 'bg-stone-100' : 'hover:bg-stone-50'
                  }`}
                >
                  + Create new cookbook…
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
