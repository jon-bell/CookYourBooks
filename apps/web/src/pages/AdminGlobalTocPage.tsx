import { useParams } from 'react-router-dom';
import { AdminTabs, RequireAdmin } from '../admin/RequireAdmin.js';
import { GlobalCookbookEditor } from '../admin/globalToc/GlobalCookbookEditor.js';
import { GlobalCookbookImport } from '../admin/globalToc/GlobalCookbookImport.js';
import { GlobalCookbookList } from '../admin/globalToc/GlobalCookbookList.js';

interface Props {
  mode?: 'list' | 'editor' | 'import';
}

export function AdminGlobalTocPage({ mode }: Props = {}) {
  const { cookbookId } = useParams<{ cookbookId?: string }>();
  const resolved = mode ?? (cookbookId ? 'editor' : 'list');
  return (
    <RequireAdmin>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <AdminTabs />
        {resolved === 'editor' && <GlobalCookbookEditor />}
        {resolved === 'list' && <GlobalCookbookList />}
        {resolved === 'import' && <GlobalCookbookImport />}
      </div>
    </RequireAdmin>
  );
}
