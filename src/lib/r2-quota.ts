import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Each user gets a fixed slice of R2's 10GB/month free tier — R2 has no
// built-in per-user quota, so this is enforced at the app level before any
// write that grows a user's storage. Paired with MAX_USERS in user-limit.ts
// (10 users * 950MB = 9.5GB, a buffer under the free tier). Decimal (SI)
// units throughout, matching how R2 reports/bills storage — 1 MB = 1,000,000
// bytes, not 1024*1024 (see format-bytes.ts).
export const MAX_USER_STORAGE_BYTES = 950 * 1_000_000;

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

// Unlike getUserStorageBytes, this isn't a quota check — any project member
// can see this via RLS, so it takes whichever client the caller already has
// (locals.supabase from a page load, not necessarily the admin client).
export async function getProjectStorageBytes(supabase: SupabaseClient<Database>, projectId: string) {
	const { data, error } = await supabase.from('files').select('size_bytes').eq('project_id', projectId);

	if (error) {
		console.log(`[storage-quota] failed to read project usage for project ${projectId}: ${error.message}`);
		return { totalBytes: 0, failed: true };
	}

	return { totalBytes: data.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0), failed: false };
}

// Admin-only: one paginated pass over every file in the bucket, bypassing RLS
// via the caller's service-role client, broken down by both uploader and
// project so the admin dashboard/projects pages don't each re-scan `files`.
export async function getGlobalStorageBreakdown(admin: SupabaseClient<Database>) {
	const byUser: Record<string, number> = {};
	const byProject: Record<string, number> = {};
	let totalBytes = 0;
	let rowCount = 0;
	let from = 0;
	let truncated = false;

	while (true) {
		const { data, error } = await admin
			.from('files')
			.select('id, size_bytes, uploaded_by, project_id')
			.range(from, from + PAGE_SIZE - 1);

		if (error) {
			console.log(`[storage-quota] failed to read global usage page at offset ${from}: ${error.message}`);
			truncated = true;
			break;
		}

		for (const row of data ?? []) {
			const bytes = row.size_bytes ?? 0;
			totalBytes += bytes;
			byUser[row.uploaded_by] = (byUser[row.uploaded_by] ?? 0) + bytes;
			byProject[row.project_id] = (byProject[row.project_id] ?? 0) + bytes;
		}
		rowCount += data?.length ?? 0;

		if (!data || data.length < PAGE_SIZE) break;
		from += PAGE_SIZE;
	}

	return { totalBytes, byUser, byProject, rowCount, truncated };
}

export async function wouldExceedUserStorageQuota(admin: SupabaseClient<Database>, userId: string, additionalBytes: number) {
	const { totalBytes, rowCount, truncated } = await getUserStorageBytes(admin, userId);

	// A truncated read only ever under-counts (it stops summing partway through),
	// so trusting the partial total could let a write through that actually blows
	// the cap. Fail closed instead — block the write and require a clean re-read.
	if (truncated) {
		console.log(
			`[storage-quota] user=${userId} rows=${rowCount} current=${totalBytes}B (TRUNCATED, lower bound only) — failing closed, blocking write`
		);
		return true;
	}

	const wouldExceed = totalBytes + additionalBytes > MAX_USER_STORAGE_BYTES;

	console.log(
		`[storage-quota] user=${userId} rows=${rowCount} current=${totalBytes}B additional=${additionalBytes}B cap=${MAX_USER_STORAGE_BYTES}B wouldExceed=${wouldExceed}`
	);

	return wouldExceed;
}
