import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { fileId } = params;

	const { data: file, error } = await locals.supabase
		.from('files')
		.select('r2_key, filename')
		.eq('id', fileId)
		.single();

	if (error || !file) {
		return new Response('File not found', { status: 404 });
	}

	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});

	const url = new URL(
	`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`
	);
	url.searchParams.set('X-Amz-Expires', '3600');
	url.searchParams.set(
		'response-content-disposition',
		`attachment; filename="${file.filename}"`
	);

	const signed = await r2.sign(new Request(url, { method: 'GET' }), {
		aws: { signQuery: true },
	});

	return Response.json({ downloadUrl: signed.url });
};