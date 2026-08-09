import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { wouldExceedStorageQuota } from '../../../../lib/r2-quota';
import { errorResponse } from '../../../../lib/error-report';

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
			return new Response('Target folder not found', { status: 400 });
		}
	}

	if (file.size_bytes) {
		const admin = getSupabaseAdmin(env);
		if (await wouldExceedStorageQuota(admin, env, locals.user.id, file.size_bytes)) {
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
		const copyErrorText = await copyRes.text();
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to copy source file in storage: ${copyErrorText}`,
			action: 'Failed to copy source file in storage.',
			status: 502,
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
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
			is_public: false,
		})
		.select('id, filename, size_bytes, mime_type, created_at, uploaded_by, is_public, profiles(display_name)')
		.single();

	if (insertError) {
		await r2.fetch(destUrl, { method: 'DELETE' }).catch(() => {});
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to save copied file: ${insertError.message}`,
			action: 'Failed to save copied file.',
			context: { fileId: fileId ?? null, projectId: file.project_id },
		});
	}

	return Response.json(created);
};
