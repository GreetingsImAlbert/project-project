import type { APIRoute } from 'astro';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Soft-delete — moves the file to the project's Trash instead of removing it.
// The R2 object is left alone until the trash cron actually purges the row (see
// src/lib/trash.ts) — restore.ts undoes this, purge.ts does the same removal on demand.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await locals.supabase
		.from('files')
		.select('project_id, is_journal')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	// The RLS update policy would allow this (Journal isn't protected there — only
	// the delete policy checks is_journal), so this app-level check is what
	// actually protects it from ending up in the trash.
	if (file.is_journal) {
		return new Response('The Journal file cannot be deleted', { status: 403 });
	}

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', file.project_id)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const { error } = await locals.supabase.from('files').update({ deleted_at: new Date().toISOString() }).eq('id', fileId);

	if (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete file: ${error.message}`,
			action: 'Failed to delete file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	return new Response(null, { status: 204 });
};
