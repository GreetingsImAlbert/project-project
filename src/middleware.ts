import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { createSupabaseServerClient } from "./lib/supabase/server";
import { getSupabaseAdmin } from "./lib/supabase/admin";
import { logError } from "./lib/error-report";
import { normalizeAvatar } from "./lib/avatars";

// Prefixes for routes that actually need auth context. Everything else
// (bot noise probing /.env, /wp-admin, etc.) skips the Supabase round trip.
//
// /forgot-password and /reset-password are pointedly absent: neither has anything to
// say to a session, and /reset-password must not so much as touch a session cookie —
// see the comment at the top of that page.
const APP_PATH_PREFIXES = ["/login", "/projects", "/api", "/admin", "/account"];

function isAppPath(pathname: string) {
    return pathname === "/" || APP_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Where a pending-deletion member is still allowed: the page that tells them
// about it, the endpoint that cancels it, and login/logout so a fresh sign-in
// (or leaving) doesn't loop back into the same redirect.
const PENDING_DELETION_ALLOWED_PATHS = [
    "/account/pending-deletion",
    "/api/account/cancel-deletion",
    "/login",
    "/api/auth/logout",
];

function isPendingDeletionAllowed(pathname: string) {
    return PENDING_DELETION_ALLOWED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

// Applied to every response, app path or not — cheap, header-only, and there's no
// reason a bot-probed 404 should skip them either.
function withSecurityHeaders(response: Response): Response {
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return response;
}

// API routes already return their own plain-text 4xx/5xx for errors they saw
// coming (see e.g. files/[id]/confirm.ts) — those never throw, so they never
// reach here. This is only for what nothing upstream anticipated. Plain text
// for /api so it lands directly in the `toastError(await res.text())` calls
// components already make; a small HTML page everywhere else since a page
// nav has no such handler to catch a bare error response.
function unexpectedErrorResponse(pathname: string, reportId: string): Response {
    if (pathname.startsWith('/api')) {
        return new Response(`Something went wrong on our end. Reference ID: ${reportId}`, { status: 500 });
    }

    return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
        `<title>Something went wrong | P2</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1" /></head>` +
        `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">` +
        `<h1>Something went wrong</h1>` +
        `<p>Sorry about that — it's been logged. If it keeps happening, send this reference to the developer:</p>` +
        `<p><code style="font-size: 1.1rem;">${reportId}</code></p>` +
        `<p><a href="/">Go back home</a></p>` +
        `</body></html>`,
        { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

export const onRequest = defineMiddleware(async (context, next) => {
    if (!isAppPath(context.url.pathname)) {
        return withSecurityHeaders(await next());
    }

    try {
        const supabase = createSupabaseServerClient(context.request, context.cookies);

        const { data, error} = await supabase.auth.getClaims();

        context.locals.supabase = supabase;
        // display_name is written into user_metadata at signup (see api/auth/signup.ts),
        // so the JWT already carries it — no profiles round trip just to name the user.
        const displayName = data?.claims.user_metadata?.display_name;
        // Same idea for the profile picture: it's an id out of a fixed list (see
        // lib/avatars.ts), mirrored into user_metadata by api/account/update-avatar.ts
        // so the navbar avatar costs nothing per request either.
        const avatar = data?.claims.user_metadata?.avatar;

        context.locals.user = error || !data ? null : {
            id: data.claims.sub,
            email: data.claims.email,
            displayName: typeof displayName === 'string' && displayName ? displayName : undefined,
            avatar: normalizeAvatar(avatar),
        };

        // app_metadata is admin-only to write (see api/account/delete.ts), so this claim
        // can't be forged by the member it's about. Everywhere else in the app redirects
        // to the pending-deletion page while it's set.
        const pendingDeletionAt = data?.claims.app_metadata?.pending_deletion_at;
        if (context.locals.user && pendingDeletionAt && !isPendingDeletionAllowed(context.url.pathname)) {
            return withSecurityHeaders(context.redirect('/account/pending-deletion'));
        }

        return withSecurityHeaders(await next());
    } catch (err) {
        // Catch-all for everything no route or page explicitly handled — see
        // src/lib/error-report.ts. This is the one place in the whole app an
        // uncaught server-side exception can't slip past without a reference id.
        const reportId = await logError(getSupabaseAdmin(env), {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : null,
            source: 'server',
            method: context.request.method,
            path: context.url.pathname,
            url: context.request.url,
            userId: context.locals.user?.id ?? null,
        });

        return withSecurityHeaders(unexpectedErrorResponse(context.url.pathname, reportId));
    }
});