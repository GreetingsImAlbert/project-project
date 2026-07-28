import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// only the owner can delete the project
	const { data: project } = await locals.supabase
		.from('projects')
		.select('owner_id')
		.eq('id', projectId)
		.single();

	if (!project || project.owner_id !== locals.user.id) {
		return new Response('Forbidden', { status: 403 });
	}

	// Read out ahead of the delete — the `files` rows (and their r2_key) disappear
	// the moment the project row cascades, so this is the last chance to see them.
	const { data: files } = await locals.supabase
		.from('files')
		.select('r2_key')
		.eq('project_id', projectId);

	const { error } = await locals.supabase.from('projects').delete().eq('id', projectId);

	if (error) {
		return new Response(`Failed to delete project: ${error.message}`, { status: 500 });
	}

	// Best-effort: the DB side is already committed via cascade, so a failed R2
	// delete here just leaks storage quietly rather than undoing the project delete.
	if (files && files.length > 0) {
		const r2 = new AwsClient({
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
			service: 's3',
			region: 'auto',
		});

		await Promise.all(
			files.map((file) => {
				const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`;
				return r2.fetch(objectUrl, { method: 'DELETE' }).catch(() => {});
			}),
		);
	}

	return new Response(null, { status: 204 });
};
