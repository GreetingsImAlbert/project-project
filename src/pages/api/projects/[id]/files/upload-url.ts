import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const body = await request.json() as { filename?: string };
    const filename = body.filename;

    if (!filename || typeof filename !== 'string') {
        return new Response('Filename is required', { status: 400 });
    }

	const r2Key = `${projectId}/${crypto.randomUUID()}-${filename}`;

	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});

	const url = new URL(
		`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${r2Key}`
	);
	url.searchParams.set('X-Amz-Expires', '3600');

	const signed = await r2.sign(new Request(url, { method: 'PUT' }), {
		aws: { signQuery: true },
	});

	return Response.json({ uploadUrl: signed.url, r2Key });
};