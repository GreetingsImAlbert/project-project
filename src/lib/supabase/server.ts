import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { AstroCookies } from 'astro';
import { env } from 'cloudflare:workers';
import type { Database } from './database.types';

// Not httpOnly-sensitive on its own (just a boolean preference), but there's no reason
// to expose it to JS either, so it gets the same treatment as the auth cookies.
export const REMEMBER_ME_COOKIE = 'p2_remember_me';
export const REMEMBER_ME_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function createSupabaseServerClient(request: Request, cookies: AstroCookies, rememberMe?: boolean) {
    return createServerClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        cookies: {
            getAll() {
                return parseCookieHeader(request.headers.get('Cookie') ?? '');
            },

            setAll(cookiesToSet) {
                // @supabase/ssr defaults every auth cookie to a 400-day maxAge. Without the
                // "stay signed in" checkbox, the auth cookie should instead die with the
                // browser session — so strip maxAge unless the user opted into 30 days.
                // Removals (signOut, etc.) come through with maxAge: 0 and must pass through
                // untouched.
                const shouldRemember = rememberMe ?? cookies.get(REMEMBER_ME_COOKIE)?.value === '1';
                cookiesToSet.forEach(({ name, value, options }) => {
                    const { maxAge, ...restOptions } = options ?? {};
                    cookies.set(name, value, {
                        ...restOptions,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'lax',
                        path: '/',
                        ...(maxAge === 0 ? { maxAge: 0 } : shouldRemember ? { maxAge: REMEMBER_ME_MAX_AGE } : {}),
                    });
                });
            }
        }
    })
}
