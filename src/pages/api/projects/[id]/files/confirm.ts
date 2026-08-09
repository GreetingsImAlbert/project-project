import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../../lib/supabase/admin';
import { wouldExceedStorageQuota } from '../../../../../lib/r2-quota';
import { MAX_FILENAME_LENGTH } from '../../../../../lib/file-kind';
import { logError } from '../../../../../lib/error-report';

export const prerender = false;

const MAX_FILE_SIZE = 100 * 1024 * 1024; // keep in sync with upload-url.ts

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const body = await request.json() as { r2Key?: string; filename?: string; mimeType?: string; folderId?: string };

	if (!body.r2Key || !body.filename) {
		return new Response('Missing r2Key or filename', { status: 400 });
	}

	if (body.filename.length > MAX_FILENAME_LENGTH) {
		return new Response(`Filename: max ${MAX_FILENAME_LENGTH} characters`, { status: 400 });
	}

	if (body.folderId) {
		const { data: folder } = await locals.supabase
			.from('folders')
			.select('id')
			.eq('id', body.folderId)
			.eq('project_id', projectId)
			.single();

		if (!folder) {
			return new Response('Folder not found', { status: 400 });
		}
	}

	// Real server-to-R2 requests over the same remote endpoint upload/download use
	// (not the R2 binding — that resolves to a separate local-only store under
	// plain `wrangler dev`, so it would silently "succeed" without touching the
	// real object).
	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
	const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${body.r2Key}`;

	// Trust R2's own record of what actually got written, not a `size` the client
	// might report — a caller can PUT any number of bytes to a presigned URL
	// regardless of what it claims in this request body.
	const headRes = await r2.fetch(objectUrl, { method: 'HEAD' });
	if (!headRes.ok) {
		return new Response('Upload not found', { status: 400 });
	}
	const sizeBytes = Number(headRes.headers.get('content-length') ?? 0);

	if (sizeBytes > MAX_FILE_SIZE) {
		await r2.fetch(objectUrl, { method: 'DELETE' }).catch(() => {});
		return new Response('Max 100MB per file', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	if (await wouldExceedStorageQuota(admin, env, locals.user.id, sizeBytes)) {
		await r2.fetch(objectUrl, { method: 'DELETE' }).catch(() => {});
		return new Response('Storage quota exceeded', { status: 507 });
	}

	const { data: created, error } = await locals.supabase
		.from('files')
		.insert({
			project_id: projectId,
			folder_id: body.folderId ?? null,
			uploaded_by: locals.user.id,
			filename: body.filename,
			r2_key: body.r2Key,
			mime_type: body.mimeType ?? null,
			size_bytes: sizeBytes,
			is_public: false,
		})
		.select('id, filename, size_bytes, mime_type, created_at, uploaded_by, is_public, profiles(display_name)')
		.single();

	if (error) {
		let cleanedUp = false;
		try {
			const deleteRes = await r2.fetch(objectUrl, { method: 'DELETE' });
			if (!deleteRes.ok) {
				throw new Error(`R2 delete responded with ${deleteRes.status}`);
			}
			cleanedUp = true;
		} catch (cleanupError) {
			console.error(`Failed to clean up orphaned R2 object ${body.r2Key}:`, cleanupError);
		}

		const reportId = await logError(admin, {
			message: `Failed to save file record: ${error.message}`,
			source: 'server',
			method: request.method,
			path: new URL(request.url).pathname,
			userId: locals.user.id,
			context: { r2Key: body.r2Key, cleanedUp },
		});

		return Response.json(
			{
				error: `Failed to save file record. Reference ID: ${reportId}`,
				cleanedUp,
			},
			{ status: 500 }
		);
	}

	return Response.json(created);
};
