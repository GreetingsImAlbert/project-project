import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const body = await request.json() as { r2Key?: string; filename?: string; size?: number; mimeType?: string; folderId?: string };

	if (!body.r2Key || !body.filename) {
		return new Response('Missing r2Key or filename', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('files')
		.insert({
			project_id: projectId,
			folder_id: body.folderId ?? null,
			uploaded_by: locals.user.id,
			filename: body.filename,
			r2_key: body.r2Key,
			mime_type: body.mimeType ?? null,
			size_bytes: body.size ?? null,
		});

	if (error) {
		let cleanedUp = false;
		try {
			// Real server-to-R2 DELETE over the same remote endpoint upload/download use
			// (not the R2 binding — that resolves to a separate local-only store under
			// plain `wrangler dev`, so it would silently "succeed" without touching the
			// real orphaned object).
			const r2 = new AwsClient({
				accessKeyId: env.R2_ACCESS_KEY_ID,
				secretAccessKey: env.R2_SECRET_ACCESS_KEY,
				service: 's3',
				region: 'auto',
			});
			const deleteUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${body.r2Key}`;
			const deleteRes = await r2.fetch(deleteUrl, { method: 'DELETE' });
			if (!deleteRes.ok) {
				throw new Error(`R2 delete responded with ${deleteRes.status}`);
			}
			cleanedUp = true;
		} catch (cleanupError) {
			console.error(`Failed to clean up orphaned R2 object ${body.r2Key}:`, cleanupError);
		}

		return Response.json(
			{
				error: `Failed to save file record: ${error.message}`,
				cleanedUp,
			},
			{ status: 500 }
		);
	}

	return new Response('OK', { status: 200 });
};