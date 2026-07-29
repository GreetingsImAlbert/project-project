import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fileKind, MAX_MODEL_BYTES } from '../../../../lib/file-kind';

export const prerender = false;

// Streams a mesh's bytes to the CAD viewer. Sibling of content.ts and proxied for the
// same reason: a browser fetch of an R2 presigned URL is cross-origin, so it would need
// CORS opened up on the bucket, whereas this stays same-origin and gives the size check
// somewhere to run. Unlike content.ts nothing is decoded or buffered — the body is piped
// straight through, so a 40 MB STL never lands in the Worker's memory.
//
// Not merged into download-url.ts either: that hands out a signed URL with an attachment
// Content-Disposition, which is a download, not something fetch() can read back.
export const GET: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { fileId } = params;

	// RLS scopes this to files in projects the caller is a member of.
	const { data: file, error } = await locals.supabase
		.from('files')
		.select('r2_key, filename, size_bytes')
		.eq('id', fileId)
		.single();

	if (error || !file) {
		return new Response('File not found', { status: 404 });
	}

	// Deliberately narrower than "not unsupported": this route exists for the viewer's
	// mesh loaders, and it must not become a general same-origin reader for every file
	// type the app happens to store.
	if (fileKind(file.filename) !== 'model') {
		return new Response('This file type is not a 3D model', { status: 415 });
	}

	if (file.size_bytes !== null && file.size_bytes > MAX_MODEL_BYTES) {
		return new Response('Model is too large to preview — download it instead', { status: 413 });
	}

	// The binding reads the bucket directly — no SigV4 signing, no subrequest to
	// r2.cloudflarestorage.com — so a repeat open costs one Worker invocation, not two.
	const object = await env.R2_BUCKET.get(file.r2_key);

	if (!object || !object.body) {
		return new Response('Could not read this file', { status: 502 });
	}

	// Second guard, for rows whose size_bytes predates the HEAD-at-upload behaviour.
	if (object.size > MAX_MODEL_BYTES) {
		return new Response('Model is too large to preview — download it instead', { status: 413 });
	}

	return new Response(object.body, {
		headers: {
			// Never the stored mime_type: these bytes are handed to a parser, and letting an
			// uploader's Content-Type reach the browser on a same-origin URL is how a file
			// gets rendered as something it isn't.
			'content-type': 'application/octet-stream',
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff',
			// A model's r2_key is immutable: the editor's PUT only accepts text kinds, and a
			// re-upload mints a fresh key, so the object behind this URL never changes in
			// place. Safe to cache for a year — a repeat open then costs zero Worker
			// invocations rather than cheap ones.
			'cache-control': 'private, max-age=31536000, immutable',
		},
	});
};
