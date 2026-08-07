import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { getReadableFile } from '../../../../lib/file-access';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { fileId } = params;

	// Members resolve through RLS; outsiders (guests and authenticated non-members)
	// only when the file is effectively public.
	const file = await getReadableFile(
		locals.supabase,
		getSupabaseAdmin(env),
		fileId,
		locals.user?.id ?? null,
	);

	if (!file) {
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
	const safeFilename = file.filename.replace(/[\\"]/g, '_');
	url.searchParams.set(
		'response-content-disposition',
		`attachment; filename="${safeFilename}"`
	);

	const signed = await r2.sign(new Request(url, { method: 'GET' }), {
		aws: { signQuery: true },
	});

	return Response.json({ downloadUrl: signed.url });
};