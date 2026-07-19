import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	const body = await request.json() as { r2Key?: string; filename?: string; size?: number; mimeType?: string };

	if (!body.r2Key || !body.filename) {
		return new Response('Missing r2Key or filename', { status: 400 });
	}

	const { error } = await locals.supabase
		.from('files')
		.insert({
			project_id: projectId,
			uploaded_by: locals.user.id,
			filename: body.filename,
			r2_key: body.r2Key,
			mime_type: body.mimeType ?? null,
			size_bytes: body.size ?? null,
		});

	if (error) {
		let cleanedUp = false;
		try {
			await env.R2_BUCKET.delete(body.r2Key);
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