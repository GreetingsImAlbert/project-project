import { defineMiddleware } from "astro:middleware";
import { createSupabaseServerClient } from "./lib/supabase/server";

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

export const onRequest = defineMiddleware(async (context, next) => {
    if (!isAppPath(context.url.pathname)) {
        return withSecurityHeaders(await next());
    }

    const supabase = createSupabaseServerClient(context.request, context.cookies);

    const { data, error} = await supabase.auth.getClaims();

    context.locals.supabase = supabase;
    // display_name is written into user_metadata at signup (see api/auth/signup.ts),
    // so the JWT already carries it — no profiles round trip just to name the user.
    const displayName = data?.claims.user_metadata?.display_name;

    context.locals.user = error || !data ? null : {
        id: data.claims.sub,
        email: data.claims.email,
        displayName: typeof displayName === 'string' && displayName ? displayName : undefined,
    };

    // app_metadata is admin-only to write (see api/account/delete.ts), so this claim
    // can't be forged by the member it's about. Everywhere else in the app redirects
    // to the pending-deletion page while it's set.
    const pendingDeletionAt = data?.claims.app_metadata?.pending_deletion_at;
    if (context.locals.user && pendingDeletionAt && !isPendingDeletionAllowed(context.url.pathname)) {
        return withSecurityHeaders(context.redirect('/account/pending-deletion'));
    }

    return withSecurityHeaders(await next());
});