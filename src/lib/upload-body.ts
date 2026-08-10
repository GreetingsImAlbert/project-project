// Shared request-body guards for the image upload endpoints. Reading the stream
// ourselves keeps a multipart request from allocating an unbounded buffer before
// the route has a chance to reject it.
export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
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

export function isUploadedFile(value: FormDataEntryValue | null): value is File {
	return value !== null && typeof value !== 'string' && typeof value.size === 'number' && typeof value.type === 'string' && typeof value.arrayBuffer === 'function';
}
