import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Buffer under R2's 10GB/month free tier — R2 has no built-in hard quota,
// so this is enforced at the app level before any write that grows storage.
export const MAX_TOTAL_STORAGE_BYTES = 9.5 * 1024 * 1024 * 1024;

const PAGE_SIZE = 1000;

export async function getTotalStorageBytes(admin: SupabaseClient<Database>) {
	let currentTotal = 0;
	let rowCount = 0;
	let from = 0;
	let truncated = false;

	while (true) {
		const { data, error } = await admin
			.from('files')
			.select('id, filename, size_bytes')
			.range(from, from + PAGE_SIZE - 1);

		if (error) {
			console.log(`[storage-quota] failed to read usage page at offset ${from}: ${error.message}`);
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

export async function wouldExceedStorageQuota(admin: SupabaseClient<Database>, additionalBytes: number) {
	const { totalBytes, rowCount, truncated } = await getTotalStorageBytes(admin);
	const wouldExceed = totalBytes + additionalBytes > MAX_TOTAL_STORAGE_BYTES;

	console.log(
		`[storage-quota] rows=${rowCount} current=${totalBytes}B additional=${additionalBytes}B cap=${MAX_TOTAL_STORAGE_BYTES}B wouldExceed=${wouldExceed}${truncated ? ' TRUNCATED (summation incomplete, current is a lower bound)' : ''}`
	);

	return wouldExceed;
}