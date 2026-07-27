import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Each user gets a fixed slice of R2's 10GB/month free tier — R2 has no
// built-in per-user quota, so this is enforced at the app level before any
// write that grows a user's storage. Paired with MAX_USERS in user-limit.ts
// (10 users * 950MB = 9.5GB, a buffer under the free tier). Decimal (SI)
// units throughout, matching how R2 reports/bills storage — 1 MB = 1,000,000
// bytes, not 1024*1024 (see format-bytes.ts).
export const MAX_USER_STORAGE_BYTES = 950 * 1_000_000;

// Every storage sum runs as a Postgres aggregate behind an RPC (see SCHEMA.md):
// one round trip returning the totals, instead of dragging every matching file
// row across the wire — 1000 at a time — to add them up in JS.

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

// Admin-only, and the third of the three sums to move into Postgres: one
// `group by uploaded_by, project_id` aggregate instead of paging every file row
// in the bucket to the Worker. Both admin pages want a different slice of the
// same scan (the dashboard sums per uploader, /admin/projects per project), so
// the RPC returns the two-key grouping once and the folds happen here — at most
// users * projects rows, not one row per file. Bypasses RLS through the caller's
// service-role client, same as before.
export async function getGlobalStorageBreakdown(admin: SupabaseClient<Database>) {
	const empty: { totalBytes: number; byUser: Record<string, number>; byProject: Record<string, number>; failed: boolean } = {
		totalBytes: 0,
		byUser: {},
		byProject: {},
		failed: true,
	};

	const { data, error } = await admin.rpc('global_storage_breakdown');

	if (error) {
		console.log(`[storage-quota] failed to read global usage breakdown: ${error.message}`);
		return empty;
	}

	const byUser: Record<string, number> = {};
	const byProject: Record<string, number> = {};
	let totalBytes = 0;

	for (const row of data ?? []) {
		// The generated types call this `number`, but it's bigint on the wire —
		// same guard the quota math needs, since a value that isn't a real number
		// would quietly poison every total it lands in.
		const bytes = asBytes(row?.total_bytes);

		if (bytes === null) {
			console.log(`[storage-quota] unusable global usage row: ${JSON.stringify(row)}`);
			return empty;
		}

		totalBytes += bytes;
		byUser[row.uploaded_by] = (byUser[row.uploaded_by] ?? 0) + bytes;
		byProject[row.project_id] = (byProject[row.project_id] ?? 0) + bytes;
	}

	return { totalBytes, byUser, byProject, failed: false };
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
