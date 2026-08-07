import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { wouldExceedUserStorageQuota } from '../../../../lib/r2-quota';
import { fileKind, isTextKind, MAX_VIEWABLE_BYTES } from '../../../../lib/file-kind';
import { getReadableFile } from '../../../../lib/file-access';

export const prerender = false;

// Built rather than written as an escape, so the source file itself stays free of a
// literal NUL byte.
const NUL = String.fromCharCode(0);

function r2Client() {
	return new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
}

function objectUrlFor(r2Key: string) {
	return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${r2Key}`;
}

// Reads a viewable file's text back through the Worker instead of handing the client a
// presigned URL like download-url.ts does. A browser `fetch` of an R2 presigned URL is
// cross-origin, so it would need CORS opened up on the bucket; proxying keeps the read
// same-origin and gives the size/type limits somewhere to actually be enforced.
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

	// Meshes are served by raw.ts, not decoded here — see isTextKind().
	const kind = fileKind(file.filename);
	if (!isTextKind(kind)) {
		return new Response('This file type cannot be previewed as text', { status: 415 });
	}

	// size_bytes is derived from a real R2 HEAD at upload time, so it's trustworthy —
	// but the response is length-checked again below in case a row predates that.
	if (file.size_bytes !== null && file.size_bytes > MAX_VIEWABLE_BYTES) {
		return new Response('File is too large to preview — download it instead', { status: 413 });
	}

	// Binding read, not the signed S3 API: drops both the SigV4 signing and the
	// subrequest for the path every file preview goes through.
	const object = await env.R2_BUCKET.get(file.r2_key);

	if (!object) {
		return new Response('Could not read this file', { status: 502 });
	}

	const bytes = await object.arrayBuffer();
	if (bytes.byteLength > MAX_VIEWABLE_BYTES) {
		return new Response('File is too large to preview — download it instead', { status: 413 });
	}

	const content = new TextDecoder('utf-8').decode(bytes);

	// A .txt that's really a renamed binary decodes to NULs and replacement characters.
	// Say so rather than painting the panel with mojibake.
	if (content.includes(NUL)) {
		return new Response('This file is not readable as text', { status: 415 });
	}

	// Whether the panel offers its Edit button at all. Decided here rather than passed in
	// as a prop, because the two surfaces that host the panel know different things: the
	// Files page has the caller's role for that one project, the Dashboard's My-files
	// modal spans every project the caller has uploaded into and has none of them.
	// Outsiders (guests included) never edit, so the query only runs for signed-in callers.
	let canEdit = false;
	if (locals.user) {
		const { data: membership } = await locals.supabase
			.from('project_members')
			.select('role')
			.eq('project_id', file.project_id)
			.eq('user_id', locals.user.id)
			.single();

		canEdit = !!membership && ['owner', 'editor'].includes(membership.role);
	}

	// The object's ETag rides along so a later save can tell whether it's overwriting the
	// same bytes it started from — see the conflict check in PUT.
	return Response.json({
		filename: file.filename,
		kind,
		content,
		canEdit,
		etag: object.httpEtag,
	});
};

// Writes an edited buffer back over the same R2 object. Deliberately not a presigned PUT
// like the upload flow: the edit is small enough to post through the Worker, and routing
// it here is what lets the type/size/quota checks and the conflict check below run at all.
export const PUT: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { fileId } = params;

	const { data: file, error: fileError } = await locals.supabase
		.from('files')
		.select('project_id, r2_key, filename, mime_type, size_bytes, uploaded_by')
		.eq('id', fileId)
		.single();

	if (fileError || !file) {
		return new Response('File not found', { status: 404 });
	}

	// RLS would refuse the size_bytes update on its own, but only after the object had
	// already been overwritten in R2 — so the role check has to come first.
	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', file.project_id)
		.eq('user_id', locals.user.id)
		.single();

	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	if (!isTextKind(fileKind(file.filename))) {
		return new Response('This file type cannot be edited', { status: 415 });
	}

	const body = (await request.json()) as { content?: unknown; etag?: unknown };

	if (typeof body.content !== 'string') {
		return new Response('Missing content', { status: 400 });
	}

	// Same cap the viewer reads under: saving past it would produce a file the editor
	// could no longer open.
	const bytes = new TextEncoder().encode(body.content);
	if (bytes.byteLength > MAX_VIEWABLE_BYTES) {
		return new Response('File is too large to save — max 1MB in the editor', { status: 413 });
	}

	const r2 = r2Client();
	const objectUrl = objectUrlFor(file.r2_key);

	const headRes = await r2.fetch(objectUrl, { method: 'HEAD' });
	if (!headRes.ok) {
		return new Response('File is missing from storage', { status: 404 });
	}

	// Last-writer-wins is the fallback, not the policy: the editor sends back the ETag it
	// loaded, and a different one here means someone else saved in the meantime. There's
	// still a window between this check and the PUT below (R2's S3 API has conditional
	// writes, but leaning on them would mean a save silently degrading to an overwrite
	// wherever they aren't honoured) — it catches the realistic case, a buffer left open
	// for minutes, not a genuine simultaneous save.
	const currentEtag = headRes.headers.get('etag');
	if (typeof body.etag === 'string' && currentEtag && body.etag !== currentEtag) {
		return new Response('This file changed since you opened it — reopen it to see the current version', { status: 409 });
	}

	// Charged to whoever uploaded the file, not whoever is editing it: getUserStorageBytes
	// sums by `uploaded_by`, so that's the account the extra bytes actually land on.
	const previousBytes = Number(headRes.headers.get('content-length') ?? file.size_bytes ?? 0);
	const growth = bytes.byteLength - previousBytes;

	if (growth > 0) {
		const admin = getSupabaseAdmin(env);
		if (await wouldExceedUserStorageQuota(admin, file.uploaded_by, growth)) {
			return new Response('Storage quota exceeded', { status: 507 });
		}
	}

	const putRes = await r2.fetch(objectUrl, {
		method: 'PUT',
		// Kept as it was uploaded, so downloads keep behaving the same way after an edit.
		headers: { 'content-type': file.mime_type || 'text/plain; charset=utf-8' },
		body: bytes,
	});

	if (!putRes.ok) {
		return new Response(`Failed to save file: ${await putRes.text()}`, { status: 502 });
	}

	// R2's own record of what landed, same rule as confirm.ts — never the length the
	// client sent, and not even the length we just encoded.
	const verifyRes = await r2.fetch(objectUrl, { method: 'HEAD' });
	if (!verifyRes.ok) {
		return new Response('Saved, but could not confirm the new size', { status: 502 });
	}
	const sizeBytes = Number(verifyRes.headers.get('content-length') ?? bytes.byteLength);

	const { error: updateError } = await locals.supabase
		.from('files')
		.update({ size_bytes: sizeBytes })
		.eq('id', fileId);

	// The object is already overwritten by this point and the pre-edit bytes are gone, so
	// there's nothing to compensate with the way confirm.ts deletes its orphan. The file
	// itself is saved; only the recorded size is stale, and the next save corrects it.
	if (updateError) {
		return new Response(`Saved, but failed to record the new size: ${updateError.message}`, { status: 500 });
	}

	return Response.json({ sizeBytes, etag: verifyRes.headers.get('etag') });
};
