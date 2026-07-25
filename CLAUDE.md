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

Never run `npm run build` (or `astro build`) either — say when a build is worth running and let the user run it. `npx tsc --noEmit -p .` and `npx astro check` are fine to run yourself, as often as needed.

## Commands

```
npm run build             # astro build -> ./dist (user runs this, never Claude)
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

These two are the whole validation story — run both after any non-trivial change, and treat them as the gate before telling the user a change is ready to test.

Neither one type-checks inside `.svelte` files: `astro check` only diagnoses `.astro`, and `tsc` skips Svelte templates entirely. `svelte-check` would cover that gap but is not installed, and running it through `npx` fails in this environment (it can't resolve `typescript` from the npx cache). So don't try to check Svelte components by running a build, a one-off compiler script, or `npx svelte-check` — re-read the component instead, and tell the user if a change is risky enough to want a real build.

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

**Cross-island shared state** (`src/lib/*.svelte.ts`): several independently-hydrated Svelte islands on the same page need to agree on one value without prop-drilling or a full reload — solved with a plain module-level `$state` object plus getter/setter functions, imported directly by every island that needs it (Svelte 5's runes work at module scope, so this is just JS, no store library). Existing ones: `currency.svelte.ts` (global currency preference), `transactions-store.svelte.ts` / `bom-store.svelte.ts` / `contributions-store.svelte.ts` (the Money page's four islands — `MoneySummary`, `BomTable`, `TransactionsTable`, `MemberContributionsTable` — all read the same items/transactions/split), `storage-usage.svelte.ts` / `project-storage.svelte.ts` (Dashboard/Overview/Files storage figures stay live across upload/copy/delete). Reach for this pattern, not prop drilling, whenever two sibling islands must reflect the same mutable data. Their `initX()` once-only guard **must** be skipped under `import.meta.env.SSR`: the module lives for the whole Worker isolate rather than one request, so an honoured guard renders the previous request's data into this request's SSR HTML. Any new store here needs the same escape hatch.

**Project pages** (`src/pages/projects/[id].astro`, `[id]/files.astro`, `[id]/money.astro`): three separate routes — Overview, Files, Money (only the nav label/route is `Money`; `BomTable.svelte`'s own heading is still `Bill of Materials`; also hosts `TransactionsTable`/`MemberContributionsTable`). Each page repeats its own auth/membership check and fetches only the data it needs, then renders `ProjectShell.astro` (two-column flex layout, `.project-shell`/`.project-main`, the '← Back to projects' link) which takes `activePage: 'overview' | 'files' | 'money'` and renders `ProjectSidebar.astro` (project title, member list only — the description now lives on the Overview page via `ProjectDescriptionEditor.svelte`, owner-editable, click-to-edit) plus a `<slot />`. Sidebar has no fold/collapse (removed — wasn't worth the interaction cost) and is `position: sticky` on desktop, `position: static` below 768px; keep its content short so sticky doesn't stop looking right. `ProjectShell.astro`'s mobile media query needs `align-items: stretch` (not just `flex-direction: column`) or the main column shrinks to its widest content's natural width (e.g. the BOM table's colgroup) instead of the viewport. `ProjectShell.astro`'s `:global(.project-main > h2:first-child)` zeroes the section-divider heading style for the first heading in main — it must be `:global` (Astro-scoped selectors never match markup authored in a different `.astro` file or inside a Svelte island), and `:global` still can't reach through the `astro-island` wrapper, so a first-heading owned by a Svelte island can't rely on it. The Money page solves that generally with `global.css`'s `.money-section-head h2` rule; anywhere else, the island has to zero the same three properties itself.

**Money page tables** (`MoneySummary.svelte`, `BomTable.svelte`, `TransactionsTable.svelte`, `MemberContributionsTable.svelte`): four separate islands that have to read as one page, so their shared look lives in `global.css` under `.money-section` / `.money-table` / `.money-panel` — **not** in any one component's scoped `<style>`, which can't reach across island boundaries. Each component renders `<section class="money-section">` with a `.money-section-head` (h2 + right-aligned count/total); that wrapper owns the section divider, and the global `.money-section-head h2` rule zeroes the default h2 divider styling, so no component needs its own h2 override any more. Tables keep `table-layout: fixed` with an explicit pixel `<colgroup>` (not `auto` or percentage-based — both were tried and looked squished/unstable), sized to total ≲960px so a 1280px viewport doesn't horizontally scroll the 240px-sidebar-narrowed main column. Numeric columns take `class="num"` (right-aligned, `tabular-nums`). Rows truncate every cell; the actions cell opts out via `.actions-cell`.

Row interaction is one slot per row holding either a read-only detail panel (row click) or an edit form (Edit button) — `openId` + `openMode`, mutually exclusive, both rendered as `<tr class="panel-row"><td colspan={colCount}>` with the slide transition on an inner `.money-panel` div (a `<tr>` can't be slid directly). Because each edit form now lives entirely inside one cell, it's a plain nested `<form>`; the old `form=`-attribute + hidden-form-outside-the-table workaround (needed when inputs were spread across sibling `<td>`s) is gone — don't reintroduce it. Add-item forms use the same `.money-panel` markup behind an 'Add …' toggle, `bind:value`-d to component-local `$state` so an in-progress row survives closing the panel (only clears on successful submit).

BOM groups by free-text `category` with a `.group-row` band per category carrying its subtotal. Transactions has no date band — the Date column already shows it, so date changes are marked with `.data-row.group-start` (a strong rule above the row); it has a `Payment` type (`related_member_id` holds the payee) so members can settle dues directly. Member Contributions is one row per member (Share / Owes total / Paid / Dues, plus an all-members footer that sums the rows above it — it used to hardcode 100% / net / net / 0, which lied whenever the stored shares didn't add up), each expanding to a `.sub-table` of that member's transactions; the last member's share is a non-editable remainder so an edited split always sums to 100. A member who joins *after* a split is saved has no percent of their own and resolves to 0% (`resolveContributionPercents` — an unset percent only means an equal share when no member has one, otherwise a newcomer's default share pushes the total past 100%); a muted note names anyone in that state until the split is saved again, and saving writes a stored share for every member, including the ones whose resolved 0% already matched the draft. The footer's percent turns red with a warning only when the stored shares genuinely don't sum to 100 (e.g. a member row was removed) — distinguishing the two cases needs the raw `contribution_percent` nulls from the prop, not the resolved numbers. All the money rules — signed amounts, net spend excluding payments, two-sided payment attribution, share resolution — live in `src/lib/money-math.ts`; add new ones there rather than in a component, since the summary strip and the tables must never disagree.

**Sidebar member roles** (`ProjectSidebar.astro`): each member row gets a `role-{owner,editor,viewer}` class colored via `--color-role-owner`/`-editor`/`-viewer` in `tokens.css` (muted red/blue/green) — add new roles to both places if the `project_members.role` check constraint ever grows.

**Type surface gotchas:**
- `src/env.d.ts` declares `App.Locals` (`supabase`, `user`) — it imports types, so it must stay wrapped in `declare global { ... } / export {}` or it stops being treated as ambient.
- Supabase's generated types can't express one-to-one cardinality through the `project_members` junction table; call sites use `.overrideTypes<...>()` as a manual workaround. Don't "fix" this with a unique constraint on `user_id` alone — that would break multi-project membership.
- A column added in code ahead of a real migration (e.g. `bom_items.category`, `transactions.related_member_id`/`supplier`, `project_members.is_auditor` — all historical now) isn't in `database.types.ts` yet, so `.overrideTypes<...>()`'s merge check silently drops it and an insert/update payload needs an `as never` to compile. Both are **temporary**: once `npm run update-types` has run, go back and delete them, or the `as never` keeps type-checking switched off on that write for good (a mistyped column then only shows up as a runtime 500). `buildBulkRows` builds its rows as a real `Database[...]['transactions']['Insert']` for exactly that reason. A second FK to the same table (`transactions.member_id` and `related_member_id` both referencing `profiles`) also makes any bare `profiles(...)` embed ambiguous to PostgREST — pin it with the explicit hint, e.g. `profiles!transactions_member_id_fkey(display_name)`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)