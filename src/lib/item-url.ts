// Supplier links are user-supplied and rendered as real <a href> in the BOM and the
// transactions table, so anything but http/https (javascript:, data:, …) is a stored
// XSS path. Shared by the BOM and transaction endpoints so all four validate alike.

export function itemUrlError(itemUrl: string | null): string | null {
	if (!itemUrl) return null;

	let parsed: URL;
	try {
		parsed = new URL(itemUrl);
	} catch {
		return 'Invalid item URL';
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return 'URL must be http or https';
	}

	return null;
}
