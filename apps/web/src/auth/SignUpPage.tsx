import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../supabase.js';
import { AppleLogo } from './AppleLogo.js';

export function SignUpPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName || email } },
    });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session) {
      navigate('/', { replace: true });
    } else {
      setInfo('Check your email (Mailpit at http://127.0.0.1:54424) to confirm.');
    }
  }

  async function handleOAuth(provider: 'google' | 'apple') {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) setError(error.message);
  }

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-semibold">Create account</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
          />
        </label>
        {error && (
          <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {info && (
          <div className="rounded border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
            {info}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <div className="relative text-center">
        <span className="bg-stone-50 dark:bg-stone-900 px-3 text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
          or
        </span>
      </div>
      <button
        type="button"
        onClick={() => void handleOAuth('google')}
        className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-4 py-2 text-sm font-medium hover:bg-stone-100 dark:hover:bg-stone-800"
      >
        Continue with Google
      </button>
      <button
        type="button"
        onClick={() => void handleOAuth('apple')}
        aria-label="Sign up with Apple"
        className="flex w-full items-center justify-center gap-2 rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 dark:bg-white dark:text-black dark:hover:bg-stone-200"
      >
        <AppleLogo className="h-4 w-4" />
        <span>Sign up with Apple</span>
      </button>
      <p className="text-center text-sm text-stone-600 dark:text-stone-400">
        Already have one?{' '}
        <Link to="/sign-in" className="font-medium text-stone-900 dark:text-stone-100 underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
