import type { SupabaseClient } from '@supabase/supabase-js';

// The row the three public-readable GET handlers (content, raw, download-url) need:
// everything required to serve the file from R2, nothing that names who uploaded it
// or where it lives in a project's private structure.
export interface ReadableFileRow {
	project_id: string;
	r2_key: string;
	filename: string;
	size_bytes: number | null;
}

// Resolves the file `fileId` that `userId` (null for guests) may read, or null when
// they may not. Members keep their existing RLS-scoped read — including trashed,
// Journal, and private files — so the member side behaves exactly as before. Everyone
// else passes only for effectively public files: the project's Files gate is on, the
// file's own switch is on, and the file is neither deleted nor the Journal file.
export async function getReadableFile(
	supabase: SupabaseClient,
	admin: SupabaseClient,
	fileId: string | undefined,
	userId: string | null,
): Promise<ReadableFileRow | null> {
	if (!fileId) return null;

	if (userId) {
		// RLS scopes this to files in projects the caller is a member of. A row that
		// errors out (non-member, or no such file) falls through to the public check
		// rather than 404ing here, so a member-invisible public file still resolves.
		const { data, error } = await supabase
			.from('files')
			.select('project_id, r2_key, filename, size_bytes')
			.eq('id', fileId)
			.single();

		if (!error && data) {
			return data;
		}
	}

	// The outsider read bypasses RLS entirely (the caller can't see files rows at all),
	// so the effectively-public conditions are enforced as SQL filters instead of
	// policies. Only the fields the handlers need to serve the file are selected.
	const { data: file } = await admin
		.from('files')
		.select('project_id, r2_key, filename, size_bytes, is_public, is_journal, deleted_at')
		.eq('id', fileId)
		.single();

	if (!file || !file.is_public || file.is_journal || file.deleted_at) {
		return null;
	}

	const { data: project } = await admin
		.from('projects')
		.select('public_files_enabled')
		.eq('id', file.project_id)
		.single();

	if (!project?.public_files_enabled) {
		return null;
	}

	return {
		project_id: file.project_id,
		r2_key: file.r2_key,
		filename: file.filename,
		size_bytes: file.size_bytes,
	};
}
