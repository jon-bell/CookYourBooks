import { useRef, useState } from 'react';
import type { RecipeCollection } from '@cookyourbooks/domain';
import { supabase } from '../supabase.js';
import { useAuth } from '../auth/AuthProvider.js';
import { CoverImage } from './CoverImage.js';

export function CoverImageEditor({
  collection,
  onChange,
}: {
  collection: RecipeCollection;
  onChange: (path: string | undefined) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    if (!user) return;
    setUploading(true);
    setError(null);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
      const path = `${user.id}/collections/${collection.id}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('covers')
        .upload(path, file, { upsert: true, cacheControl: '3600' });
      if (uploadError) throw uploadError;
      await onChange(path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    if (!collection.coverImagePath) return;
    setUploading(true);
    setError(null);
    try {
      await supabase.storage.from('covers').remove([collection.coverImagePath]);
      await onChange(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-4">
        <CoverImage
          path={collection.coverImagePath}
          className="h-24 w-36 rounded-md border border-stone-200"
        />
        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-800 disabled:opacity-50"
            >
              {uploading ? 'Uploading…' : collection.coverImagePath ? 'Replace cover' : 'Add cover'}
            </button>
            {collection.coverImagePath && (
              <button
                onClick={remove}
                disabled={uploading}
                className="rounded-md px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = '';
            }}
          />
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
