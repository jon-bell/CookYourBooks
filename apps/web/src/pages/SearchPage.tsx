import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { searchLibrary, type SourceType } from '@cookyourbooks/domain';
import { useCollections } from '../data/queries.js';

type Filter = '' | SourceType;

export function SearchPage() {
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState<Filter>('');
  const { data: collections = [], isLoading } = useCollections();
  const hits = useMemo(() => {
    const visible = sourceType
      ? collections.filter((c) => c.sourceType === sourceType)
      : collections;
    return searchLibrary(visible, q);
  }, [collections, q, sourceType]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Search</h1>
      <div className="flex flex-wrap gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by recipe title or ingredient…"
          className="flex-1 rounded-md border border-stone-300 px-3 py-2"
          autoFocus
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as Filter)}
          aria-label="Filter by collection type"
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">All collections</option>
          <option value="PERSONAL">Personal</option>
          <option value="PUBLISHED_BOOK">Cookbooks</option>
          <option value="WEBSITE">Web</option>
        </select>
      </div>
      {isLoading ? (
        <p className="text-stone-500">Loading…</p>
      ) : (
        <>
          <div className="text-sm text-stone-600">
            {q
              ? `${hits.length} ${hits.length === 1 ? 'result' : 'results'}`
              : `${hits.length} recipes`}
          </div>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
            {hits.map(({ collection, recipe }) => (
              <li key={recipe.id}>
                <Link
                  to={`/collections/${collection.id}/recipes/${recipe.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-stone-50"
                >
                  <span>
                    <span className="font-medium">{recipe.title}</span>
                    <span className="ml-2 text-sm text-stone-500">· {collection.title}</span>
                  </span>
                  <span className="text-sm text-stone-400">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
