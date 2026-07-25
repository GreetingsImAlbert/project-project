import { defineMiddleware } from "astro:middleware";
import { createSupabaseServerClient } from "./lib/supabase/server";

// Prefixes for routes that actually need auth context. Everything else
// (bot noise probing /.env, /wp-admin, etc.) skips the Supabase round trip.
const APP_PATH_PREFIXES = ["/login", "/projects", "/api", "/admin"];

function isAppPath(pathname: string) {
    return pathname === "/" || APP_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const onRequest = defineMiddleware(async (context, next) => {
    if (!isAppPath(context.url.pathname)) {
        return next();
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

    return next();
});