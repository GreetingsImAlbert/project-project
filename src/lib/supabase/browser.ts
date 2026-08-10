import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

// The one place this app runs Supabase-JS in the browser rather than on the
// Worker. Every other page talks to Supabase only through Astro.locals.supabase
// (a per-request server client bound to httpOnly cookies the browser can't read)
// — but Postgres Changes needs a live websocket held by the tab itself, and that
// has no server-side equivalent.
//
// PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY are Vite's `import.meta.env`
// public vars (inlined into the client bundle at build time), not the `env` from
// `cloudflare:workers` the rest of the app uses — that binding only exists on the
// Worker. They mirror SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY and need adding to
// .env (local) and the Cloudflare Pages/Workers build environment (deployed).
// The publishable key is safe to ship to the browser by design —
// it's what RLS exists to make safe. Mode-specific builds are enforced by
// scripts/build.mjs so staging cannot fall back to production's .env values. This
// client still carries no session of
// its own (persistSession: false): it only ever speaks for whichever project
// member handed it a token via realtime.setAuth(), see journal-realtime.ts.
export function createBrowserSupabaseClient() {
	return createClient<Database>(
		import.meta.env.PUBLIC_SUPABASE_URL,
		import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
		{
			auth: {
				persistSession: false,
				autoRefreshToken: false,
				detectSessionInUrl: false,
			},
		},
	);
}
