import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const fileId = params.fileId;

	const { data: file, error: fileError } = await locals.supabase
		.from('files')
		.select('project_id, r2_key, is_journal')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	// The RLS delete policy already refuses this (see SCHEMA.md), but that would
	// surface as a bare "Failed to delete file: ..." — this gives the real reason.
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

	const { error } = await locals.supabase.from('files').delete().eq('id', fileId);

	if (error) {
		return new Response(`Failed to delete file: ${error.message}`, { status: 500 });
	}

	// Real signed R2 request (not the Workers binding, which resolves to a
	// separate local-only store under plain `wrangler dev`) — mirrors copy.ts/confirm.ts.
	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
	const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`;
	await r2.fetch(objectUrl, { method: 'DELETE' }).catch(() => {});

	return new Response(null, { status: 204 });
};
