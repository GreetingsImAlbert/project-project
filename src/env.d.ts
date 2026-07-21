/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

import type { SupabaseClient } from "@supabase/supabase-js";

declare global {
    namespace App {
        interface Locals {
            supabase: SupabaseClient;
            user: { id: string; email: string | undefined } | null;
        }
    }
}

export {};