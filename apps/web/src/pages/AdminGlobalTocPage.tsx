import { useParams } from 'react-router-dom';
import { AdminTabs, RequireAdmin } from '../admin/RequireAdmin.js';
import { GlobalCookbookEditor } from '../admin/globalToc/GlobalCookbookEditor.js';
import { GlobalCookbookList } from '../admin/globalToc/GlobalCookbookList.js';

export function AdminGlobalTocPage() {
  const { cookbookId } = useParams<{ cookbookId?: string }>();
  return (
    <RequireAdmin>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <AdminTabs />
        {cookbookId ? <GlobalCookbookEditor /> : <GlobalCookbookList />}
      </div>
    </RequireAdmin>
  );
}
