import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Kept small on purpose — see MAX_USER_STORAGE_BYTES in r2-quota.ts
// (10 users * 950MB = 9.5GB, a buffer under R2's free tier).
export const MAX_USERS = 10;

export async function wouldExceedUserLimit(admin: SupabaseClient<Database>) {
	const { count, error } = await admin
		.from('profiles')
		.select('id', { count: 'exact', head: true });

	if (error) {
		console.log(`[user-limit] failed to count profiles: ${error.message}`);
		return false;
	}

	const wouldExceed = (count ?? 0) >= MAX_USERS;
	console.log(`[user-limit] count=${count} cap=${MAX_USERS} wouldExceed=${wouldExceed}`);
	return wouldExceed;
}
