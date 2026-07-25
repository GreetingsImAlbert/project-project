import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import { fileKind, MAX_VIEWABLE_BYTES } from '../../../../lib/file-kind';

export const prerender = false;

// Reads a viewable file's text back through the Worker instead of handing the client a
// presigned URL like download-url.ts does. A browser `fetch` of an R2 presigned URL is
// cross-origin, so it would need CORS opened up on the bucket; proxying keeps the read
// same-origin and gives the size/type limits somewhere to actually be enforced.
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

	const kind = fileKind(file.filename);
	if (kind === 'unsupported') {
		return new Response('This file type cannot be previewed', { status: 415 });
	}

	// size_bytes is derived from a real R2 HEAD at upload time, so it's trustworthy —
	// but the response is length-checked again below in case a row predates that.
	if (file.size_bytes !== null && file.size_bytes > MAX_VIEWABLE_BYTES) {
		return new Response('File is too large to preview — download it instead', { status: 413 });
	}

	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});

	const objectUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${file.r2_key}`;
	const res = await r2.fetch(objectUrl, { method: 'GET' });

	if (!res.ok) {
		return new Response('Could not read this file', { status: 502 });
	}

	const bytes = await res.arrayBuffer();
	if (bytes.byteLength > MAX_VIEWABLE_BYTES) {
		return new Response('File is too large to preview — download it instead', { status: 413 });
	}

	const content = new TextDecoder('utf-8').decode(bytes);

	// A .txt that's really a renamed binary decodes to NULs and replacement characters.
	// Say so rather than painting the panel with mojibake.
	if (content.includes('\u0000')) {
		return new Response('This file is not readable as text', { status: 415 });
	}

	return Response.json({ filename: file.filename, kind, content });
};
