import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { AstroCookies } from 'astro';
import { env } from 'cloudflare:workers';

export function createSupabaseServerClient(request: Request, cookies: AstroCookies) {
    return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        cookies: {
            getAll() {
                return parseCookieHeader(request.headers.get('Cookie') ?? '');
            },
        
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value, options }) => 
                    cookies.set(name, value, options)            
                );
            }
        }
    })
}