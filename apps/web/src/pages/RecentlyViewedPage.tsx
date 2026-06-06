import { Link } from 'react-router-dom';
import { RecentlyViewedList } from '../cooking/RecentlyViewedList.js';

export function RecentlyViewedPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Recently viewed</h1>
        <Link to="/cooking" className="text-sm text-stone-600 hover:underline dark:text-stone-400">
          ← Cooking tracker
        </Link>
      </div>
      <p className="text-sm text-stone-500">
        Your personal browsing history, kept on this device only.
      </p>
      <RecentlyViewedList />
    </div>
  );
}
