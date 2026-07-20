import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { AstroCookies } from 'astro';
import { env } from 'cloudflare:workers';
import type { Database } from './database.types';

export function createSupabaseServerClient(request: Request, cookies: AstroCookies) {
    return createServerClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        cookies: {
            getAll() {
                return parseCookieHeader(request.headers.get('Cookie') ?? '');
            },
        
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value, options }) => 
                    cookies.set(name, value, {
                        ...options,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'lax',
                        path: '/',
                    })            
                );
            }
        }
    })
}