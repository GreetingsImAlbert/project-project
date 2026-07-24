import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Uses whichever client the caller passes in (normally locals.supabase, the
// RLS-scoped one) — the "users can read own profile" policy already limits
// this to the caller's own row via .eq('id', userId), so there's no need to
// reach for the service-role admin client just for this check.
export async function isAdminUser(supabase: SupabaseClient<Database>, userId: string) {
	const { data } = await supabase.from('profiles').select('is_admin').eq('id', userId).single();
	return data?.is_admin === true;
}
