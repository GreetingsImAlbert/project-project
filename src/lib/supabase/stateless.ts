import { createClient } from '@supabase/supabase-js';
import { env } from 'cloudflare:workers';
import type { Database } from './database.types';

// A Supabase client bound to no cookies and no storage at all — the deliberate
// opposite of createSupabaseServerClient. Two auth flows need one:
//
//   - changing an account password, where the current password is verified by
//     signing in with it. On locals.supabase that sign-in would overwrite this
//     browser's session cookies as a side effect of what is only meant to be a
//     check.
//   - password recovery, where a recovery session has to live just long enough to
//     set the new password and then be thrown away, without ever writing a session
//     cookie for this browser (see api/auth/reset-password.ts).
//
// flowType 'implicit' is chosen, not incidental. @supabase/ssr defaults to PKCE,
// and a PKCE recovery link comes back as `?code=`, exchangeable only with the
// verifier cookie held by the browser that asked for the reset — which breaks the
// ordinary "request it on the laptop, open the mail on the phone" case. Implicit
// puts the tokens in the URL fragment instead, and a fragment is never sent to the
// server, which is exactly the property the reset page depends on: the page can
// render with no session because it literally cannot see a token.
export function createStatelessSupabaseClient() {
	return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
		auth: {
			flowType: 'implicit',
			persistSession: false,
			autoRefreshToken: false,
			detectSessionInUrl: false,
		},
	});
}
