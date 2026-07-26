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

// Both storage sums run as Postgres aggregates behind an RPC (see SCHEMA.md):
// one round trip returning one number, instead of dragging every file row the
// user/project owns across the wire — 1000 at a time — to add them up in JS.

// The generated types call both aggregates `number`, but they're bigint on the
// wire and the quota math has to fail closed: NaN + additionalBytes > cap is
// `false`, so anything that isn't a real number would wave the write through
// rather than block it. Treated as a failed read instead.
function asBytes(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export async function getUserStorageBytes(admin: SupabaseClient<Database>, userId: string) {
	const { data, error } = await admin.rpc('user_storage_bytes', { target_user_id: userId });

	if (error) {
		console.log(`[storage-quota] failed to read usage for user ${userId}: ${error.message}`);
		return { totalBytes: 0, rowCount: 0, failed: true };
	}

	// Set-returning, so it arrives as a one-row array — an aggregate over zero
	// rows still returns that row, and no row at all means the read didn't work.
	const row = data?.[0];
	const totalBytes = asBytes(row?.total_bytes);

	if (totalBytes === null) {
		console.log(`[storage-quota] unusable usage total for user ${userId}: ${JSON.stringify(row)}`);
		return { totalBytes: 0, rowCount: 0, failed: true };
	}

	return { totalBytes, rowCount: asBytes(row?.row_count) ?? 0, failed: false };
}

// Unlike getUserStorageBytes, this isn't a quota check — any project member
// can see this via RLS, so it takes whichever client the caller already has
// (locals.supabase from a page load, not necessarily the admin client). The RPC
// is `security invoker`, so RLS applies to it exactly as it did to the old
// select: a non-member sums nothing and gets 0.
export async function getProjectStorageBytes(supabase: SupabaseClient<Database>, projectId: string) {
	const { data, error } = await supabase.rpc('project_storage_bytes', { check_project_id: projectId });

	if (error) {
		console.log(`[storage-quota] failed to read project usage for project ${projectId}: ${error.message}`);
		return { totalBytes: 0, failed: true };
	}

	const totalBytes = asBytes(data);

	if (totalBytes === null) {
		console.log(`[storage-quota] unusable usage total for project ${projectId}: ${JSON.stringify(data)}`);
		return { totalBytes: 0, failed: true };
	}

	return { totalBytes, failed: false };
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
	const { totalBytes, rowCount, failed } = await getUserStorageBytes(admin, userId);

	// A failed read reports 0 bytes used, which would let any write through no
	// matter how full the account already is. Fail closed instead — block the
	// write and require a clean re-read.
	if (failed) {
		console.log(`[storage-quota] user=${userId} usage read FAILED — failing closed, blocking write`);
		return true;
	}

	const wouldExceed = totalBytes + additionalBytes > MAX_USER_STORAGE_BYTES;

	console.log(
		`[storage-quota] user=${userId} rows=${rowCount} current=${totalBytes}B additional=${additionalBytes}B cap=${MAX_USER_STORAGE_BYTES}B wouldExceed=${wouldExceed}`
	);

	return wouldExceed;
}
