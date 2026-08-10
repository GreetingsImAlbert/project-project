import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { errorResponse } from '../../../../lib/error-report';
import {
	CUSTOM_AVATAR_BUCKET,
	CUSTOM_AVATAR_MAX_BYTES,
	CUSTOM_AVATAR_MAX_REQUEST_BYTES,
	isProjectPictureOwner,
	isAvatarId,
	isUuid,
	parseCustomAvatarBytes,
	projectAvatarCleanupPath,
	projectAvatarReplacementPath,
	projectAvatarStoragePath,
} from '../../../../lib/avatars';
import type { Database } from '../../../../lib/supabase/database.types';
import { isUploadedFile, readBoundedRequestBody } from '../../../../lib/upload-body';

export const prerender = false;

type ProjectAvatarRow = {
	owner_id: string;
	avatar: string | null;
};

type ProjectAvatarUpdate = Database['public']['Tables']['projects']['Update'] & {
	avatar: string | null;
};

async function removeStoredProjectAvatar(admin: ReturnType<typeof getSupabaseAdmin>, avatar: string | null) {
	const cleanupPath = projectAvatarCleanupPath(avatar);
	if (!cleanupPath) return;
	const { error } = await admin.storage.from(CUSTOM_AVATAR_BUCKET).remove([cleanupPath]);
	if (error) console.error(`[project-picture] failed to remove ${cleanupPath}: ${error.message}`);
}

export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;
	if (!isUuid(projectId)) {
		return new Response('Project not found', { status: 404 });
	}

	const { data: project, error: projectError } = await locals.supabase
		.from('projects')
		.select('owner_id, avatar')
		.eq('id', projectId)
		.maybeSingle()
		.overrideTypes<ProjectAvatarRow>();

	if (projectError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to read project picture: ${projectError.message}`,
			action: 'Failed to read project picture.',
			context: { projectId },
		});
	}
	if (!project || !isProjectPictureOwner(project.owner_id, locals.user.id)) {
		return new Response('Forbidden', { status: 403 });
	}

	const requestBody = await readBoundedRequestBody(request, CUSTOM_AVATAR_MAX_REQUEST_BYTES);
	if (!requestBody) {
		return new Response('Request body is too large', { status: 413 });
	}

	const formData = await new Request(request, { body: requestBody.buffer }).formData();
	const submitted = formData.get('avatar');
	let avatar: string | null = null;
	let uploadedFile: { bytes: Uint8Array; mimeType: string } | null = null;

	if (typeof submitted === 'string') {
		if (submitted !== '') {
			if (!isAvatarId(submitted)) {
				return new Response('Choose a built-in picture, upload a JPEG, PNG, or WebP image, or use the owner picture.', { status: 400 });
			}
			avatar = submitted;
		}
	} else if (isUploadedFile(submitted)) {
		if (submitted.size > CUSTOM_AVATAR_MAX_BYTES) {
			return new Response(`This image is ${(submitted.size / (1024 * 1024)).toFixed(2)} MB. The maximum is 5.00 MB.`, { status: 400 });
		}

		const parsedImage = parseCustomAvatarBytes(new Uint8Array(await submitted.arrayBuffer()));
		if (!parsedImage) {
			return new Response('Choose a JPEG, PNG, or WebP image no larger than 5 MB.', { status: 400 });
		}
		uploadedFile = { bytes: parsedImage.bytes, mimeType: parsedImage.mimeType };
	} else {
		return new Response('No picture was received.', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	let uploadedAvatar: string | null = null;
	if (uploadedFile) {
		uploadedAvatar = projectAvatarStoragePath(projectId);
		const { error: uploadError } = await admin.storage.from(CUSTOM_AVATAR_BUCKET).upload(uploadedAvatar, uploadedFile.bytes, {
			contentType: uploadedFile.mimeType,
			cacheControl: '31536000',
			upsert: false,
		});

		if (uploadError) {
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to store project picture: ${uploadError.message}`,
				action: 'Failed to store project picture.',
				status: 502,
				context: { projectId },
			});
		}
		avatar = uploadedAvatar;
	}

	const { data: updated, error: updateError } = await locals.supabase
		.from('projects')
		.update({ avatar } as ProjectAvatarUpdate)
		.eq('id', projectId)
		.eq('owner_id', locals.user.id)
		.select('id')
		.single();

	if (updateError || !updated) {
		await removeStoredProjectAvatar(admin, uploadedAvatar);
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update project picture: ${updateError?.message ?? 'project was not updated'}`,
			action: 'Failed to update project picture.',
			context: { projectId },
		});
	}

	// Every uploaded path is unique, so deleting the old object cannot remove the
	// newly selected picture. Built-in ids and NULL need no Storage cleanup.
	const replacedAvatar = projectAvatarReplacementPath(project.avatar, avatar);
	if (replacedAvatar) await removeStoredProjectAvatar(admin, replacedAvatar);

	return Response.json({ avatar });
};
