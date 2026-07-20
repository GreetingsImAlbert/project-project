import { defineMiddleware } from "astro:middleware";
import { createSupabaseServerClient } from "./lib/supabase/server";

export const onRequest = defineMiddleware(async (context, next) => {
    const supabase = createSupabaseServerClient(context.request, context.cookies);

    const { data, error} = await supabase.auth.getClaims();

    context.locals.supabase = supabase;
    context.locals.user = error || !data ? null : {
        id: data.claims.sub,
        email: data.claims.email,
    } as typeof context.locals.user;

    return next();
});