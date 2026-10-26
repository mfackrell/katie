"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let ownerAuthClient: SupabaseClient | null | undefined;

/** Public/publishable key only. Never use the service-role key in the browser. */
export function browserOwnerAuth(): SupabaseClient | null {
  if (ownerAuthClient !== undefined) return ownerAuthClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return ownerAuthClient = null;
  return ownerAuthClient = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
}

export async function ownerSessionBearer(): Promise<string | null> {
  const client = browserOwnerAuth();
  if (!client) return null;
  // Owner authorization is optional for ordinary chat. Never hold the chat
  // request indefinitely while Supabase restores or refreshes a browser session.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await Promise.race([
      client.auth.getSession().then(({ data, error }) =>
        error ? null : data.session?.access_token ?? null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 4000);
      }),
    ]);
    return session;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
