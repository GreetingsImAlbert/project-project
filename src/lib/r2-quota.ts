import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Each user gets a fixed slice of R2's 10GB/month free tier — R2 has no
// built-in per-user quota, so this is enforced at the app level before any
// write that grows a user's storage. Paired with MAX_USERS in user-limit.ts
// (10 users * 950MB = 9.5GB, a buffer under the free tier).
export const MAX_USER_STORAGE_BYTES = 950 * 1024 * 1024;

const PAGE_SIZE = 1000;

export async function getUserStorageBytes(admin: SupabaseClient<Database>, userId: string) {
	let currentTotal = 0;
	let rowCount = 0;
	let from = 0;
	let truncated = false;

	while (true) {
		const { data, error } = await admin
			.from('files')
			.select('id, filename, size_bytes')
			.eq('uploaded_by', userId)
			.range(from, from + PAGE_SIZE - 1);

		if (error) {
			console.log(`[storage-quota] failed to read usage page for user ${userId} at offset ${from}: ${error.message}`);
			truncated = true;
			break;
		}

		for (const row of data ?? []) {
			currentTotal += row.size_bytes ?? 0;
		}
		rowCount += data?.length ?? 0;

		if (!data || data.length < PAGE_SIZE) break;
		from += PAGE_SIZE;
	}

	return { totalBytes: currentTotal, rowCount, truncated };
}

export async function wouldExceedUserStorageQuota(admin: SupabaseClient<Database>, userId: string, additionalBytes: number) {
	const { totalBytes, rowCount, truncated } = await getUserStorageBytes(admin, userId);
	const wouldExceed = totalBytes + additionalBytes > MAX_USER_STORAGE_BYTES;

	console.log(
		`[storage-quota] user=${userId} rows=${rowCount} current=${totalBytes}B additional=${additionalBytes}B cap=${MAX_USER_STORAGE_BYTES}B wouldExceed=${wouldExceed}${truncated ? ' TRUNCATED (summation incomplete, current is a lower bound)' : ''}`
	);

	return wouldExceed;
}
