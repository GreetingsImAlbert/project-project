# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

P2 is a project-management web app for engineering students/hobbyists (CAD files, drawings, calculations, BOM, collaboration). Solo project, deployed at p2.albertmendoza.com.

## Tech stack

- Astro 7 (SSR, `output: 'server'`) + Svelte 5 for interactive components, TypeScript throughout
- Cloudflare Workers via `@astrojs/cloudflare`, custom domain p2.albertmendoza.com, Wrangler CLI for local dev/deploy
- Supabase: Postgres (schema + RLS) and Auth (email/password, JWT)
- Cloudflare R2 for file storage, accessed via presigned S3-style URLs signed with `aws4fetch` (no AWS SDK)
- Resend as custom SMTP provider for Supabase Auth emails (configured in the Supabase dashboard, not in app code — see CHECKLIST.md)
- Plain CSS (no Tailwind/UnoCSS) — design tokens + global styles in `src/styles/`, self-hosted IBM Plex Mono via `@fontsource/ibm-plex-mono`

## Task tracking

Every time you provide a commit message, first update `CHECKLIST.md` to reflect it — move finished items to Done, add newly-discovered follow-ups, and keep In progress/Next up current. Do this as part of the same commit, not a separate one.

## Commit messages

Give the user the commit message text — do not run `git commit` yourself. Format: a short summary line prefixed with a conventional-commit type (`feat:`, `fix:`, `docs:`, `refactor:`, `style:`, `chore:`, ...), blank line, then a bulleted list of what changed, one bullet per change, starting with a verb (`Add`/`Change`/`Fix`/`Remove`/...):

```
<type>: <short summary line>

- Add ...
- Change ...
- Fix ...
```

Never use `"` (double quotes) anywhere in a commit message — use single quotes or backticks instead.

## Development

Do not start the dev server yourself. When a change is ready to test, tell the user and let them start/run it manually — they will test it themselves.

## Commands

```
npm run build             # astro build -> ./dist
npm run generate-types    # wrangler types -> worker-configuration.d.ts (Cloudflare bindings/env)
npm run update-types      # supabase gen types -> src/lib/supabase/database.types.ts (Supabase schema)
npx wrangler dev          # deploy locally to 127.0.0.1:8787 using the result of npm run build
```

Do not make edits to a file that is meant to be automatically generated such as database.types.ts. If it is not crucial to run before you proceed, just wait until the end and tell me to run the required command (e.g. npm run update-types).

## Validation

There is no lint or test script configured in this project. Run these regularly instead, especially after touching types, `locals`, or Supabase call sites:

```
npx tsc --noEmit -p .     # TypeScript type-check, whole project
npx astro check           # Astro-aware type-check (.astro files + TS)
```

## Architecture

**Request flow / auth:**
- `src/middleware.ts` runs on every request to an app path (`/`, `/login`, `/projects*`, `/api*`, `/admin*` — see `APP_PATH_PREFIXES`). It builds a per-request Supabase client and calls `supabase.auth.getClaims()` (not `getUser()`/`getSession()` — verifies the JWT locally against the asymmetric signing key instead of a network round trip), then populates `context.locals.user` (`{id, email} | null`, mapped from `claims.sub`/`claims.email` — not the full Supabase `User` shape) and `context.locals.supabase`. Paths outside that allow-list skip Supabase entirely to avoid wasting Worker CPU on bot noise.
- `src/lib/supabase/server.ts` creates the session-aware, cookie-bound client used for basically all reads/writes — respects Postgres RLS policies keyed off the authenticated user.
- `src/lib/supabase/admin.ts`'s `getSupabaseAdmin(env)` creates a service-role client that bypasses RLS. No longer a narrow exception — it's now the standard client for anything that must read/aggregate across users (storage-quota checks in `r2-quota.ts`, the admin dashboard, `user-limit.ts`'s signup cap, the add-member email lookup). Still: prefer `locals.supabase` whenever the read is naturally scoped to the caller (RLS does the enforcement), and reach for the admin client only when the operation is legitimately cross-user by design.
- Every page under `src/pages/` sets `export const prerender = false` and does its own `if (!Astro.locals.user) return Astro.redirect('/login')` — there's no route-group-level guard, so new protected pages must repeat this check. `admin/*` pages additionally call `isAdminUser()` (`src/lib/admin-guard.ts`, checks `profiles.is_admin` via `locals.supabase` — RLS already scopes it to the caller's own row, no admin client needed for the check itself) before touching any admin client / cross-user data.

**Data model:** full table/column/policy/trigger definitions are in `SCHEMA.md` — a manually-maintained snapshot, not auto-generated, so update it there whenever schema/RLS changes in the Supabase dashboard. Operational notes not obvious from the SQL alone:
- `folders.parent_folder_id` is self-referential with `ON DELETE CASCADE`, `files.folder_id` is `ON DELETE SET NULL`. Any endpoint accepting a client-supplied parent/folder id must verify it belongs to the same project before using it — otherwise a folder can be linked under a different project's folder and get silently cascade-deleted later.
- Always derive `files.size_bytes` from a real R2 `HEAD` request server-side — never trust a client-reported size.
- `bom_items`/`transactions` RLS both mirror the `folders` pattern (`is_project_member`/`project_role`, no creator column to check).
- Three triggers run automatically outside app code (see `SCHEMA.md`): `on_auth_user_created` creates the `profiles` row (and, via `pg_advisory_xact_lock`, atomically enforces `MAX_USERS` at insert time — closes a TOCTOU race the app-level check in `user-limit.ts` can't close on its own), `on_project_created` adds the creator to `project_members` as owner.

**File upload/download flow** (`UploadForm.svelte`, child of `FileBrowser.svelte` — not a sibling island, so it always sees the live `currentFolderId` as the user navigates client-side): client asks `POST /api/projects/[id]/files/upload-url` for a presigned R2 PUT URL, `PUT`s the file directly to R2, then calls `POST /api/projects/[id]/files/confirm` to insert the `files` row (re-derives real size via R2 `HEAD`, doesn't trust the client); if that insert fails, the endpoint compensates by deleting the just-uploaded R2 object (no real transaction across R2 + Postgres). Downloads go through `GET /api/files/[fileId]/download-url`. When touching presigned URLs: don't sign/send `Content-Type`; add query params like `response-content-disposition` before signing, not after; strip `\`/`"` from any filename that lands in that header. Move/Copy/Delete for both files and folders are driven by a single Actions popover per row (`FileList.svelte`/`FileBrowser.svelte`), with `FolderPickerModal.svelte` as the shared destination picker for Move/Copy.

**Storage quota** (`src/lib/r2-quota.ts`): a 950MB-per-user cap (`MAX_USER_STORAGE_BYTES`, decimal/SI bytes — matches how R2 itself reports usage, not binary 1024-based units) enforced at `upload-url.ts`/`confirm.ts`/`copy.ts` via `wouldExceedUserStorageQuota`, paired with a 10-user signup cap (`user-limit.ts`). All quota/usage reads fail **closed**: a truncated paginated read blocks the write (or hides the displayed number behind a reload prompt) rather than trusting a partial sum. `getProjectStorageBytes` takes whichever client the caller has (RLS already scopes it correctly, any member can see it); `getUserStorageBytes`/`getGlobalStorageBreakdown` require the admin client since they read across users.

**Cross-island shared state** (`src/lib/*.svelte.ts`): several independently-hydrated Svelte islands on the same page need to agree on one value without prop-drilling or a full reload — solved with a plain module-level `$state` object plus getter/setter functions, imported directly by every island that needs it (Svelte 5's runes work at module scope, so this is just JS, no store library). Existing ones: `currency.svelte.ts` (global currency preference), `transactions-store.svelte.ts` (shared `transactions` array so `TransactionsTable`/`MemberContributionsTable` stay in sync), `storage-usage.svelte.ts` / `project-storage.svelte.ts` (Dashboard/Overview/Files storage figures stay live across upload/copy/delete). Reach for this pattern, not prop drilling, whenever two sibling islands must reflect the same mutable data.

**Project pages** (`src/pages/projects/[id].astro`, `[id]/files.astro`, `[id]/money.astro`): three separate routes — Overview, Files, Money (only the nav label/route is `Money`; `BomTable.svelte`'s own heading is still `Bill of Materials`; also hosts `TransactionsTable`/`MemberContributionsTable`). Each page repeats its own auth/membership check and fetches only the data it needs, then renders `ProjectShell.astro` (two-column flex layout, `.project-shell`/`.project-main`, the '← Back to projects' link) which takes `activePage: 'overview' | 'files' | 'money'` and renders `ProjectSidebar.astro` (project title, member list only — the description now lives on the Overview page via `ProjectDescriptionEditor.svelte`, owner-editable, click-to-edit) plus a `<slot />`. Sidebar has no fold/collapse (removed — wasn't worth the interaction cost) and is `position: sticky` on desktop, `position: static` below 768px; keep its content short so sticky doesn't stop looking right. `ProjectShell.astro`'s mobile media query needs `align-items: stretch` (not just `flex-direction: column`) or the main column shrinks to its widest content's natural width (e.g. the BOM table's colgroup) instead of the viewport. `ProjectShell.astro`'s `:global(.project-main > h2:first-child)` zeroes the section-divider heading style for the first heading in main — it must be `:global` (Astro-scoped selectors never match markup authored in a different `.astro` file or inside a Svelte island), and any first-heading owned by a Svelte island (e.g. `BomTable.svelte`'s `<h2>Bill of Materials</h2>`) has to zero the same three properties in its own scoped `<style>` instead, since `:global` still can't reach through the `astro-island` wrapper.

**BOM/Transactions/Member Contributions tables** (`BomTable.svelte`, `TransactionsTable.svelte`, `MemberContributionsTable.svelte`): `table-layout: fixed` with an explicit pixel `<colgroup>` (not `auto` or percentage-based — both were tried and looked squished/unstable across expand states). Display rows truncate every cell (`nowrap` + `text-overflow: ellipsis`) for uniform row height; clicking a row (except the actions cell or a link) toggles `expandedId` to show full content for just that row. The actions cell is excluded from truncation/click-toggle and forced `white-space: nowrap; flex-shrink: 0`. Add-item forms are collapsed behind an 'Add ...' toggle, `bind:value`-d to component-local `$state` so an in-progress row survives closing the panel (only clears on successful submit). BOM groups by free-text `category`; Transactions groups by date and has a `Payment` type (`related_member_id` holds the payee) so members can settle dues directly — payments are excluded from net project spend and are two-sided in the Member Contributions dues math.

**Sidebar member roles** (`ProjectSidebar.astro`): each member row gets a `role-{owner,editor,viewer}` class colored via `--color-role-owner`/`-editor`/`-viewer` in `tokens.css` (muted red/blue/green) — add new roles to both places if the `project_members.role` check constraint ever grows.

**Type surface gotchas:**
- `src/env.d.ts` declares `App.Locals` (`supabase`, `user`) — it imports types, so it must stay wrapped in `declare global { ... } / export {}` or it stops being treated as ambient.
- Supabase's generated types can't express one-to-one cardinality through the `project_members` junction table; call sites use `.overrideTypes<...>()` as a manual workaround. Don't "fix" this with a unique constraint on `user_id` alone — that would break multi-project membership.
- A column added in code ahead of a real migration (e.g. `bom_items.category`, `transactions.related_member_id` historically) isn't in `database.types.ts` yet, so `.overrideTypes<...>()`'s merge check silently drops it — cast the raw query result directly instead until `npm run update-types` catches up (see `money.astro`'s `transactions` query for the pattern). A second FK to the same table (`transactions.member_id` and `related_member_id` both referencing `profiles`) also makes any bare `profiles(...)` embed ambiguous to PostgREST — pin it with the explicit hint, e.g. `profiles!transactions_member_id_fkey(display_name)`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)