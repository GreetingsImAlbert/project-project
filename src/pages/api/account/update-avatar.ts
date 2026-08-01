import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../lib/supabase/admin';
import {
	CUSTOM_AVATAR_MARKER,
	CUSTOM_AVATAR_MAX_REQUEST_BYTES,
	isAvatarId,
	isCustomAvatarDataUrl,
	parseCustomAvatarDataUrl,
} from '../../../lib/avatars';

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

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const requestBody = await readRequestBody(request, CUSTOM_AVATAR_MAX_REQUEST_BYTES);
	if (!requestBody) {
		return new Response('Request body is too large', { status: 413 });
	}

	const formData = await new Request(request, { body: requestBody.buffer }).formData();
	const raw = formData.get('avatar')?.toString() ?? '';
	// '' clears the picture back to the initial fallback. Built-ins use their fixed id;
	// custom pictures must pass the data-url, byte-size, and file-signature checks.
	const avatar = raw === '' ? null : raw;

	if (avatar !== null && !isAvatarId(avatar) && !parseCustomAvatarDataUrl(avatar)) {
		return new Response('Use a JPEG, PNG, or WebP image no larger than 120 KB after compression', { status: 400 });
	}

	const authAvatar = avatar && isCustomAvatarDataUrl(avatar) ? CUSTOM_AVATAR_MARKER : avatar;

	// Same two-places-one-write shape as update-display-name.ts: profiles.avatar is what
	// other members read. The JWT carries either a built-in id or the small custom marker
	// so the navbar can resolve the current picture without carrying the image in a cookie.
	// profiles still has no UPDATE policy — this half goes through the service-role client
	// with the column list and the row both pinned server-side.
	const admin = getSupabaseAdmin(env);

	const { data: previous, error: readError } = await admin
		.from('profiles')
		.select('avatar')
		.eq('id', locals.user.id)
		.single();

	if (readError || !previous) {
		return new Response(`Failed to update profile picture: ${readError?.message ?? 'profile not found'}`, { status: 500 });
	}

	const { error: profileError } = await admin
		.from('profiles')
		.update({ avatar })
		.eq('id', locals.user.id);

	if (profileError) {
		return new Response(`Failed to update profile picture: ${profileError.message}`, { status: 500 });
	}

	const { error: authError } = await locals.supabase.auth.updateUser({
		data: { avatar: authAvatar },
	});

	if (authError) {
		await admin.from('profiles').update({ avatar: previous.avatar }).eq('id', locals.user.id);
		const previousAuthAvatar = previous.avatar && isCustomAvatarDataUrl(previous.avatar) ? CUSTOM_AVATAR_MARKER : previous.avatar;
		await locals.supabase.auth.updateUser({ data: { avatar: previousAuthAvatar } });
		return new Response(`Failed to update profile picture: ${authError.message}`, { status: 500 });
	}

	// updateUser doesn't mint a new access token, and getClaims() keeps reading the old
	// JWT until it expires — refreshing puts the new avatar in the cookie the very next
	// request reads, same reason as update-display-name.ts.
	await locals.supabase.auth.refreshSession();

	return Response.json({ avatar });
};
