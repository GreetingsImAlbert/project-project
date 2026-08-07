// Rate-limiting for the unauthenticated auth endpoints (login, signup,
// forgot-password). Each endpoint has its own binding in wrangler.jsonc; the
// key scheme is what keeps one endpoint's abuse from spilling into another's.
//
// Each request checks two keys against the same limiter:
//   - `ip:<CF-Connecting-IP>` — caps how many attempts one client can make,
//     which is the credential-stuffing / signup-spam vector.
//   - `email:<normalized-email>` — caps attempts aimed at one address from
//     many clients, so a single target account can't be hammered from a botnet.
//
// Cloudflare headers are safe to trust here: `cf-connecting-ip` is set by the
// edge and the Worker runs behind it. The fallback when it's absent (local
// dev, tests) is a fixed string — never a client-supplied header.
//
// Limits are per-Cloudflare-location and eventually consistent, which is fine
// for throttling abuse; see the rate-limit binding docs for the caveats.

interface RateLimiter {
	limit(config: { key: string }): Promise<{ success: boolean }>;
}

const RATE_LIMIT_FALLBACK_IP = 'unknown';
const RATE_LIMIT_MESSAGE = 'Too many requests. Try again in a minute.';
const RATE_LIMIT_RETRY_AFTER_SECONDS = '60';

export function rateLimitResponse(): Response {
	return new Response(RATE_LIMIT_MESSAGE, {
		status: 429,
		headers: { 'Retry-After': RATE_LIMIT_RETRY_AFTER_SECONDS },
	});
}

// Returns a 429 response when either key is over its limit, or null when the
// request is allowed through. The email is never echoed in the response, and
// a blocked request must not reach Supabase — call this before any validation
// or auth work that costs a round trip.
export async function checkAuthRateLimit(
	limiter: RateLimiter,
	request: Request,
	email?: string,
): Promise<Response | null> {
	const ip = request.headers.get('cf-connecting-ip')?.trim();
	const keys = [ip ? `ip:${ip}` : `ip:${RATE_LIMIT_FALLBACK_IP}`];

	const normalizedEmail = email?.trim().toLowerCase();
	if (normalizedEmail) {
		keys.push(`email:${normalizedEmail}`);
	}

	for (const key of keys) {
		const { success } = await limiter.limit({ key });
		if (!success) {
			return rateLimitResponse();
		}
	}

	return null;
}
