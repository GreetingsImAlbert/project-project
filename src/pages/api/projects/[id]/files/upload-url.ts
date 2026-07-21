import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../../lib/supabase/admin';
import { wouldExceedStorageQuota } from '../../../../../lib/r2-quota';

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

	const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB, adjust to what CAD files realistically need
	const body = await request.json() as { filename?: string; size?: number };
	if (body.size && body.size > MAX_FILE_SIZE) {
		return new Response('File too large', { status: 400 });
	}

	if (body.size) {
		const admin = getSupabaseAdmin(env);
		if (await wouldExceedStorageQuota(admin, body.size)) {
			return new Response('Storage quota exceeded', { status: 507 });
		}
	}

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