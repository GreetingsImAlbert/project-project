import { handle } from '@astrojs/cloudflare/handler';
import { getSupabaseAdmin } from './lib/supabase/admin';
import { finalizeStaleDrafts } from './lib/journal';
import { purgeExpiredPendingDeletions, purgeOrphanedFiles } from './lib/account-deletion';
import { purgeTrash } from './lib/trash';

// Astro's Cloudflare adapter only ever exports a `fetch` handler — see
// @astrojs/cloudflare/entrypoints/server.js — and has no config surface for
// adding a Cron Trigger's scheduled() handler alongside it. This file replaces
// that entrypoint as wrangler.jsonc's `main` (per Astro's own docs for custom
// Worker exports) and re-exports the same `handle`, so every request still goes
// through Astro's SSR exactly as before; `scheduled` is the only thing added.
export default {
	async fetch(request, env, ctx) {
		return handle(request, env, ctx);
	},

	// Fires once a day (see wrangler.jsonc's triggers.crons) to roll every
	// project's Journal draft over — see finalizeStaleDrafts for what that means.
	// waitUntil rather than awaiting directly: the platform tears the invocation
	// down once this function returns, and the work here is all async I/O
	// (Postgres, R2) that would otherwise be cut off mid-flight.
	async scheduled(_controller, env, ctx) {
		const admin = getSupabaseAdmin(env);
		ctx.waitUntil(finalizeStaleDrafts(admin, env));
		// Same daily tick handles both halves of account deletion's grace periods —
		// see SCHEMA.md's "Account deletion" section for what each one does.
		ctx.waitUntil(purgeExpiredPendingDeletions(admin));
		ctx.waitUntil(purgeOrphanedFiles(admin, env));
		// Trash-bin purge — see SCHEMA.md's "Trash bin" section.
		ctx.waitUntil(purgeTrash(admin, env));
	},
} satisfies ExportedHandler<Env>;
