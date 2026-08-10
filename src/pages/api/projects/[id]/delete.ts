import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../lib/error-report';
import { CUSTOM_AVATAR_BUCKET, isProjectPictureOwner, projectAvatarCleanupPath } from '../../../../lib/avatars';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';

export const prerender = false;

type ProjectDeleteRow = {
	owner_id: string;
	avatar: string | null;
};

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	// only the owner can delete the project
	const { data: project } = await locals.supabase
		.from('projects')
		.select('owner_id, avatar')
		.eq('id', projectId)
		.single()
		.overrideTypes<ProjectDeleteRow>();

	if (!project || !isProjectPictureOwner(project.owner_id, locals.user.id)) {
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
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to delete project: ${error.message}`,
			action: 'Failed to delete project.',
			context: { projectId: projectId ?? null },
		});
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

	// The project row is already committed, so Storage cleanup is best-effort. The
	// strict project path check excludes built-in ids and the owner's fallback avatar.
	const projectAvatarPath = projectAvatarCleanupPath(project.avatar);
	if (projectAvatarPath) {
		const { error: avatarError } = await getSupabaseAdmin(env)
			.storage.from(CUSTOM_AVATAR_BUCKET)
			.remove([projectAvatarPath]);
		if (avatarError) console.error(`[project-delete] failed to remove ${projectAvatarPath}: ${avatarError.message}`);
	}

	return new Response(null, { status: 204 });
};
