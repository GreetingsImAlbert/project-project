import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import {
	CUSTOM_AVATAR_BUCKET,
	CUSTOM_AVATAR_MARKER,
	CUSTOM_AVATAR_MAX_REQUEST_BYTES,
	avatarStoragePath,
	avatarUploadMimeType,
	isAvatarId,
	isCustomAvatarDataUrl,
	isStoredAvatarPath,
	parseCustomAvatarDataUrl,
} from '../../../lib/avatars';
import { errorResponse } from '../../../lib/error-report';

export const prerender = false;

async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null) {
		const parsedLength = Number(contentLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) return null;
	}

	if (!request.body) return new Uint8Array(new ArrayBuffer(0));

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function removeStoredAvatar(admin: ReturnType<typeof getSupabaseAdmin>, avatar: string | null) {
	if (!avatar || !isStoredAvatarPath(avatar)) return;
	await admin.storage.from(CUSTOM_AVATAR_BUCKET).remove([avatar]);
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
	return value !== null && typeof value !== 'string' && typeof value.size === 'number' && typeof value.type === 'string' && typeof value.arrayBuffer === 'function';
}

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const requestBody = await readRequestBody(request, CUSTOM_AVATAR_MAX_REQUEST_BYTES);
	if (!requestBody) {
		return new Response('Request body is too large', { status: 413 });
	}

	const formData = await new Request(request, { body: requestBody.buffer }).formData();
	const submitted = formData.get('avatar');
	let avatar: string | null = null;
	let uploadedFile: { bytes: Uint8Array; mimeType: string } | null = null;

	if (typeof submitted === 'string') {
		if (submitted !== '') {
			if (isAvatarId(submitted)) {
				avatar = submitted;
			} else {
				const legacyImage = parseCustomAvatarDataUrl(submitted);
				if (!legacyImage) {
					return new Response('Choose a JPEG, PNG, or WebP image no larger than 5 MB.', { status: 400 });
				}
				uploadedFile = { bytes: legacyImage.bytes, mimeType: legacyImage.mimeType };
			}
		}
	} else if (isUploadedFile(submitted)) {
		if (submitted.size > 5 * 1024 * 1024) {
			return new Response(`This image is ${(submitted.size / (1024 * 1024)).toFixed(2)} MB. The maximum is 5.00 MB.`, { status: 400 });
		}
		const mimeType = avatarUploadMimeType(submitted.type, submitted.name);
		if (!mimeType) {
			return new Response('Choose an image file. The maximum size is 5.00 MB.', { status: 400 });
		}
		uploadedFile = { bytes: new Uint8Array(await submitted.arrayBuffer()), mimeType };
	} else {
		return new Response('No image file was received. Choose a JPEG, PNG, or WebP image.', { status: 400 });
	}

	const admin = getSupabaseAdmin(env);
	const { data: previous, error: readError } = await admin
		.from('profiles')
		.select('avatar')
		.eq('id', locals.user.id)
		.single();

	if (readError || !previous) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update profile picture: ${readError?.message ?? 'profile not found'}`,
			action: 'Failed to update profile picture.',
		});
	}

	let uploadedAvatar: string | null = null;
	if (uploadedFile) {
		uploadedAvatar = avatarStoragePath(locals.user.id, uploadedFile.mimeType);
		const { error: uploadError } = await admin.storage.from(CUSTOM_AVATAR_BUCKET).upload(uploadedAvatar, uploadedFile.bytes, {
			contentType: uploadedFile.mimeType,
			cacheControl: '31536000',
			upsert: false,
		});

		if (uploadError) {
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to store profile picture: ${uploadError.message}`,
				action: 'Failed to store profile picture.',
				status: 502,
			});
		}
		avatar = uploadedAvatar;
	}

	const { error: profileError } = await admin
		.from('profiles')
		.update({ avatar })
		.eq('id', locals.user.id);

	if (profileError) {
		await removeStoredAvatar(admin, uploadedAvatar);
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update profile picture: ${profileError.message}`,
			action: 'Failed to update profile picture.',
		});
	}

	const authAvatar = avatar && isStoredAvatarPath(avatar) ? CUSTOM_AVATAR_MARKER : avatar;
	const { error: authError } = await locals.supabase.auth.updateUser({
		data: { avatar: authAvatar },
	});

	if (authError) {
		await admin.from('profiles').update({ avatar: previous.avatar }).eq('id', locals.user.id);
		await removeStoredAvatar(admin, uploadedAvatar);
		const previousAuthAvatar = previous.avatar && (isCustomAvatarDataUrl(previous.avatar) || isStoredAvatarPath(previous.avatar)) ? CUSTOM_AVATAR_MARKER : previous.avatar;
		await locals.supabase.auth.updateUser({ data: { avatar: previousAuthAvatar } });
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to update profile picture: ${authError.message}`,
			action: 'Failed to update profile picture.',
		});
	}

	// The new object is unique, so deleting the old one cannot destroy the current
	// picture. Legacy data URLs need no storage cleanup and are replaced by the path.
	if (previous.avatar !== avatar) {
		await removeStoredAvatar(admin, previous.avatar);
	}

	await locals.supabase.auth.refreshSession();
	return Response.json({ avatar });
};
