import type { APIRoute } from 'astro';
import { MAX_FILENAME_LENGTH } from '../../../../lib/file-kind';

export const prerender = false;

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

	// RLS would allow this (rename doesn't touch is_journal), but the Journal page
	// looks the file up by the is_journal flag alone, so this is purely a UX guard —
	// the "no action buttons" rule for the Journal file, enforced server-side too.
	if (file.is_journal) {
		return new Response('The Journal file cannot be renamed', { status: 403 });
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

	const body = await request.json() as { filename?: string };
	const filename = body.filename?.trim();

	if (!filename) {
		return new Response('Filename is required', { status: 400 });
	}

	if (filename.length > MAX_FILENAME_LENGTH) {
		return new Response(`Filename: max ${MAX_FILENAME_LENGTH} characters`, { status: 400 });
	}

	const { error } = await locals.supabase
		.from('files')
		.update({ filename })
		.eq('id', fileId);

	if (error) {
		return new Response(`Failed to rename file: ${error.message}`, { status: 500 });
	}

	return new Response(null, { status: 204 });
};
