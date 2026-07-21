import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, redirect }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await locals.supabase
		.from('files')
		.select('project_id, filename, r2_key, mime_type, size_bytes')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
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

	const formData = await request.formData();
	const targetFolderId = formData.get('folderId')?.toString() || null;
	const returnFolderId = formData.get('returnFolderId')?.toString() || null;

	if (targetFolderId) {
		const { data: targetFolder } = await locals.supabase
			.from('folders')
			.select('id')
			.eq('id', targetFolderId)
			.eq('project_id', file.project_id)
			.single();

		if (!targetFolder) {
			return new Response('Target folder not found in this project', { status: 400 });
		}
	}

	const source = await env.R2_BUCKET.get(file.r2_key);
	if (!source) {
		return new Response('Source file missing from storage', { status: 404 });
	}

	const newR2Key = `${file.project_id}/${crypto.randomUUID()}-${file.filename}`;

	await env.R2_BUCKET.put(newR2Key, source.body, {
		httpMetadata: source.httpMetadata,
	});

	const { error: insertError } = await locals.supabase.from('files').insert({
		project_id: file.project_id,
		folder_id: targetFolderId,
		uploaded_by: locals.user.id,
		filename: file.filename,
		r2_key: newR2Key,
		mime_type: file.mime_type,
		size_bytes: file.size_bytes,
	});

	if (insertError) {
		await env.R2_BUCKET.delete(newR2Key);
		return new Response(`Failed to save copied file: ${insertError.message}`, { status: 500 });
	}

	const redirectUrl = returnFolderId
		? `/projects/${file.project_id}?folder=${returnFolderId}`
		: `/projects/${file.project_id}`;

	return redirect(redirectUrl);
};