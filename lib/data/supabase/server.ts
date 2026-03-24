import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

export function getSupabaseServerClient() {
  return getSupabaseAdminClient();
}
