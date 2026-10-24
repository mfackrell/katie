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
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) return null;
  return data.session.access_token;
}
