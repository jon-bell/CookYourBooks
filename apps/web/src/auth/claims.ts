import type { Session } from '@supabase/supabase-js';

/**
 * Auth context carried in the access-token JWT by the
 * `custom_access_token_hook` (see
 * supabase/migrations/20260623000000_jwt_auth_hook.sql). RLS reads the
 * same claims via `auth.jwt()`, so decoding them client-side lets the UI
 * and sync engine agree with the database on the caller's household /
 * admin status without an extra round-trip.
 */
export interface AuthClaims {
  /** Active household id, or null when the user isn't in one. */
  householdId: string | null;
  /** Whether the user is in public.admins. */
  isAdmin: boolean;
}

const EMPTY: AuthClaims = { householdId: null, isAdmin: false };

/** Decode a base64url segment (the JWT payload) to a UTF-8 string. */
function base64UrlDecode(segment: string): string | null {
  try {
    let b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad === 2) b64 += '==';
    else if (pad === 3) b64 += '=';
    else if (pad === 1) return null;
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read our custom claims out of the session's access token. The token is
 * already verified by Supabase before the session exists; we only decode
 * (never trust it for authorization — RLS does that server-side), so a
 * plain payload decode is enough.
 */
export function claimsFromSession(session: Session | null): AuthClaims {
  const token = session?.access_token;
  if (!token) return EMPTY;
  const parts = token.split('.');
  if (parts.length < 2) return EMPTY;
  const json = base64UrlDecode(parts[1]!);
  if (!json) return EMPTY;
  try {
    const payload = JSON.parse(json) as Record<string, unknown>;
    const hh = payload.household_id;
    const admin = payload.is_admin;
    return {
      householdId: typeof hh === 'string' && hh.length > 0 ? hh : null,
      isAdmin: admin === true || admin === 'true',
    };
  } catch {
    return EMPTY;
  }
}
