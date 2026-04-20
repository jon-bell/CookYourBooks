import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { useAuth } from '../auth/AuthProvider.js';

// Server-persisted shopping items — the "pantry" / extras list. This
// is the same surface the MCP server reads and writes, so items added
// by an AI assistant show up here and edits in either place reach the
// other via the `shopping_list_items` realtime channel.

interface PantryItem {
  id: string;
  name: string;
  quantity_text: string | null;
  note: string | null;
  recipe_id: string | null;
  checked: boolean;
  created_at: string;
}

type Row = Omit<PantryItem, 'created_at'> & { created_at: string };

export function PantrySection() {
  const { user } = useAuth();
  const [items, setItems] = useState<PantryItem[]>([]);
  const [draftName, setDraftName] = useState('');
  const [draftQuantity, setDraftQuantity] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await supabase
        .from('shopping_list_items')
        .select('id,name,quantity_text,note,recipe_id,checked,created_at')
        .order('checked', { ascending: true })
        .order('created_at', { ascending: false });
      if (!cancelled && !error && data) setItems(data as Row[]);
      if (!cancelled) setLoading(false);
    }
    void load();

    // Realtime: MCP writes happen on the server, so we lean on the
    // postgres_changes channel to reflect them in the UI without a
    // manual refresh.
    const channel = supabase
      .channel('shopping_list_items_self')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shopping_list_items' },
        () => void load(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [user]);

  async function add() {
    const name = draftName.trim();
    if (!name) return;
    setDraftName('');
    setDraftQuantity('');
    // Optimistic: the realtime INSERT echo will reconcile.
    const { error } = await supabase.from('shopping_list_items').insert({
      owner_id: user!.id,
      name,
      quantity_text: draftQuantity.trim() || null,
    });
    if (error) {
      // Surface the error in-place; don't lose the typed text.
      setDraftName(name);
      setDraftQuantity(draftQuantity);
      alert(error.message);
    }
  }

  async function toggle(item: PantryItem) {
    await supabase
      .from('shopping_list_items')
      .update({ checked: !item.checked, updated_at: new Date().toISOString() })
      .eq('id', item.id);
  }

  async function remove(item: PantryItem) {
    await supabase.from('shopping_list_items').delete().eq('id', item.id);
  }

  if (loading) return null;

  const hasChecked = items.some((i) => i.checked);

  return (
    <section className="space-y-2" data-testid="pantry-section">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Pantry</h2>
          <p className="text-xs text-stone-500">
            Extras and ad-hoc items. Also what your AI assistant edits via the MCP tools.
          </p>
        </div>
        {hasChecked && (
          <button
            onClick={async () => {
              await supabase
                .from('shopping_list_items')
                .delete()
                .eq('checked', true);
            }}
            className="text-xs text-stone-500 hover:text-stone-900 hover:underline"
          >
            Clear checked
          </button>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          aria-label="Pantry item"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="Add an item (e.g. whole milk)"
          className="flex-1 min-w-[220px] rounded border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          aria-label="Quantity"
          value={draftQuantity}
          onChange={(e) => setDraftQuantity(e.target.value)}
          placeholder="Quantity (optional)"
          className="w-40 rounded border border-stone-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={!draftName.trim()}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {items.length > 0 && (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Checked: ${item.name}`}
                checked={item.checked}
                onChange={() => void toggle(item)}
              />
              <span
                className={`flex-1 ${item.checked ? 'text-stone-400 line-through' : ''}`}
              >
                {item.quantity_text && (
                  <span className="font-medium">{item.quantity_text} </span>
                )}
                {item.name}
                {item.note && (
                  <span className="ml-2 text-xs text-stone-500">· {item.note}</span>
                )}
              </span>
              <button
                onClick={() => void remove(item)}
                aria-label={`Remove ${item.name}`}
                className="text-xs text-stone-500 hover:text-red-700"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
