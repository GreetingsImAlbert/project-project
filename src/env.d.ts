/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
// astro/client doesn't pull in Vite's asset-import declarations (only its import-meta
// ones) — needed explicitly for the `?url` import in cad-worker.ts.
/// <reference types="vite/client" />

import type { SupabaseClient } from "@supabase/supabase-js";

declare global {
    namespace App {
        interface Locals {
            supabase: SupabaseClient;
            user: { id: string; email: string | undefined; displayName: string | undefined; avatar: string | null } | null;
        }
    }
}

// Vite public env vars, inlined into the client bundle — see lib/supabase/browser.ts.
interface ImportMetaEnv {
    readonly PUBLIC_SUPABASE_URL: string;
    readonly PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

export {};