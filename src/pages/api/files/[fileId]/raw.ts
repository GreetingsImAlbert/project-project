import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
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

	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});

	const res = await r2.fetch(
		`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`,
		{ method: 'GET' }
	);

	if (!res.ok || !res.body) {
		return new Response('Could not read this file', { status: 502 });
	}

	// Second guard, for rows whose size_bytes predates the HEAD-at-upload behaviour. The
	// body is still streamed rather than measured, so this reads R2's own header instead.
	const length = Number(res.headers.get('content-length'));
	if (Number.isFinite(length) && length > MAX_MODEL_BYTES) {
		return new Response('Model is too large to preview — download it instead', { status: 413 });
	}

	return new Response(res.body, {
		headers: {
			// Never the stored mime_type: these bytes are handed to a parser, and letting an
			// uploader's Content-Type reach the browser on a same-origin URL is how a file
			// gets rendered as something it isn't.
			'content-type': 'application/octet-stream',
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff',
			// Signed R2 reads shouldn't be re-fetched every time the panel reopens, but the
			// object can be overwritten in place, so this stays private and short.
			'cache-control': 'private, max-age=60',
		},
	});
};
