import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export function getSupabaseAdmin(env: Env) {
	return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
}