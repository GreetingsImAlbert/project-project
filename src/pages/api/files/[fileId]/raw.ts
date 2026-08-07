import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { fileKind, MAX_MODEL_BYTES, MAX_PDF_BYTES } from '../../../../lib/file-kind';
import { getReadableFile } from '../../../../lib/file-access';
import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

// Streams binary preview bytes to the CAD and PDF viewers. Sibling of content.ts and proxied for the
// same reason: a browser fetch of an R2 presigned URL is cross-origin, so it would need
// CORS opened up on the bucket, whereas this stays same-origin and gives the size check
// somewhere to run. Unlike content.ts nothing is decoded or buffered — the body is piped
// straight through, so a 40 MB STL never lands in the Worker's memory.
//
// Not merged into download-url.ts either: that hands out a signed URL with an attachment
// Content-Disposition, which is a download, not something fetch() can read back.
export const GET: APIRoute = async ({ params, request, locals }) => {
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

	// Deliberately narrower than "not unsupported": this route must not become a general
	// same-origin reader for every file type the app happens to store.
	const kind = fileKind(file.filename);
	if (kind !== 'model' && kind !== 'pdf') {
		return new Response('This file type cannot be previewed as binary data', { status: 415 });
	}

	const maxBytes = kind === 'model' ? MAX_MODEL_BYTES : MAX_PDF_BYTES;
	const label = kind === 'model' ? 'Model' : 'PDF';
	if (file.size_bytes !== null && file.size_bytes > maxBytes) {
		return new Response(`${label} is too large to preview — download it instead`, { status: 413 });
	}

	// The binding reads the bucket directly — no SigV4 signing, no subrequest to
	// r2.cloudflarestorage.com — so a repeat open costs one Worker invocation, not two.
	const object = await env.R2_BUCKET.get(file.r2_key);

	if (!object || !object.body) {
		return errorResponse({
			request,
			userId: locals.user?.id ?? null,
			privateMessage: 'Could not read this file: no R2 object found',
			action: 'Could not read this file.',
			status: 502,
			context: { fileId: fileId ?? null },
		});
	}

	// Second guard, for rows whose size_bytes predates the HEAD-at-upload behaviour.
	if (object.size > maxBytes) {
		return new Response(`${label} is too large to preview — download it instead`, { status: 413 });
	}

	return new Response(object.body, {
		headers: {
			// Never the stored mime_type: the extension allowlist above decides whether these
			// bytes are parsed as a model or handed to the browser's PDF viewer.
			'content-type': kind === 'pdf' ? 'application/pdf' : 'application/octet-stream',
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff',
			// A binary file's r2_key is immutable: the editor's PUT only accepts text kinds, and a
			// re-upload mints a fresh key, so the object behind this URL never changes in
			// place. Safe to cache for a year — a repeat open then costs zero Worker
			// invocations rather than cheap ones.
			'cache-control': 'private, max-age=31536000, immutable',
		},
	});
};
