import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { wouldExceedStorageQuota } from '../../../../lib/r2-quota';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
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

	const body = await request.json() as { folderId?: string | null };
	const targetFolderId = body.folderId || null;

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

	if (file.size_bytes) {
		const admin = getSupabaseAdmin(env);
		if (await wouldExceedStorageQuota(admin, file.size_bytes)) {
			return new Response('Storage quota exceeded', { status: 507 });
		}
	}

	const newR2Key = `${file.project_id}/${crypto.randomUUID()}-${file.filename}`;

	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});

	// Real server-to-R2 COPY over the same remote endpoint upload/download use
	// (not the R2 binding — that resolves to a separate local-only store under
	// plain `wrangler dev`, so it would never see objects written via presigned URLs).
	const destUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${newR2Key}`;
	const encodedSourceKey = file.r2_key.split('/').map(encodeURIComponent).join('/');
	const copySource = `/${env.R2_BUCKET_NAME}/${encodedSourceKey}`;

	const copyRes = await r2.fetch(destUrl, {
		method: 'PUT',
		headers: { 'x-amz-copy-source': copySource },
	});

	if (!copyRes.ok) {
		return new Response(`Failed to copy source file in storage: ${await copyRes.text()}`, { status: 502 });
	}

	const { data: created, error: insertError } = await locals.supabase
		.from('files')
		.insert({
			project_id: file.project_id,
			folder_id: targetFolderId,
			uploaded_by: locals.user.id,
			filename: file.filename,
			r2_key: newR2Key,
			mime_type: file.mime_type,
			size_bytes: file.size_bytes,
		})
		.select('id, filename, size_bytes, mime_type, created_at, profiles(display_name)')
		.single();

	if (insertError) {
		await r2.fetch(destUrl, { method: 'DELETE' }).catch(() => {});
		return new Response(`Failed to save copied file: ${insertError.message}`, { status: 500 });
	}

	return Response.json(created);
};
