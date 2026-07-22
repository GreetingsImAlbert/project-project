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

## Validation

There is no lint or test script configured in this project. Run these regularly instead, especially after touching types, `locals`, or Supabase call sites:

```
npx tsc --noEmit -p .     # TypeScript type-check, whole project
npx astro check           # Astro-aware type-check (.astro files + TS)
```

## Architecture

**Request flow / auth:**
- `src/middleware.ts` runs on every request to an app path (`/`, `/login`, `/projects*`, `/api*` — see the allow-list at the top of the file). It builds a per-request Supabase client and calls `supabase.auth.getClaims()` (not `getUser()`/`getSession()` — this verifies the JWT locally against the asymmetric signing key instead of a network round trip), then populates `context.locals.user` (`{id, email} | null`, mapped from `claims.sub`/`claims.email` — not the full Supabase `User` shape) and `context.locals.supabase`. Paths outside that allow-list skip Supabase entirely to avoid wasting Worker CPU on bot noise.
- `src/lib/supabase/server.ts` creates the session-aware, cookie-bound client used for basically all reads/writes — it respects Postgres RLS policies keyed off the authenticated user.
- `src/lib/supabase/admin.ts` creates a service-role client that bypasses RLS. Used narrowly and deliberately (currently only the email→user lookup in the add-member endpoint) — don't reach for it as a default; prefer `locals.supabase` so RLS stays the enforcement point.
- Every page under `src/pages/` sets `export const prerender = false` and does its own `if (!Astro.locals.user) return Astro.redirect('/login')` — there's no route-group-level guard, so new protected pages must repeat this check.

**Data model:** full table/column/policy/trigger definitions are in `SCHEMA.md` — it's a manually-maintained snapshot, not auto-generated, so update it there whenever schema/RLS changes in the Supabase dashboard. Operational notes not obvious from the SQL alone:
- `folders.parent_folder_id` is self-referential with `ON DELETE CASCADE`, and `files.folder_id` is `ON DELETE SET NULL`. Any endpoint accepting a client-supplied parent/folder id must verify it belongs to the same project before using it — otherwise a folder can be linked under a different project's folder and get silently cascade-deleted later.
- Always derive `files.size_bytes` from a real R2 `HEAD` request server-side — never trust a client-reported size, since nothing else constrains what actually gets PUT to a presigned upload URL.
- `bom_items` RLS mirrors the `folders` pattern (`is_project_member`/`project_role`, no creator column to check).
- Two triggers run automatically outside app code: `on_auth_user_created` creates the `profiles` row, `on_project_created` adds the creator to `project_members` as owner.

**File upload/download flow** (see `src/components/UploadForm.svelte`/`FileList.svelte` + the API routes they call): client asks `POST /api/projects/[id]/files/upload-url` for a presigned R2 PUT URL, `PUT`s the file directly to R2 from the browser, then calls `POST /api/projects/[id]/files/confirm` to insert the `files` row (which re-derives the real size via an R2 `HEAD` request rather than trusting the client); if that insert fails, the endpoint compensates by deleting the just-uploaded R2 object (no real transaction across R2 + Postgres). Downloads go through `GET /api/files/[fileId]/download-url` for a presigned GET. When touching presigned URLs: don't sign/send `Content-Type`; add query params like `response-content-disposition` before signing, not after.

**Folder browsing** (`src/components/FileBrowser.svelte`, used from `src/pages/projects/[id].astro`): breadcrumbs and subfolder links are handled entirely client-side (the full per-project folder tree is passed down once from SSR) so clicking into a folder doesn't reload the page — it calls `GET /api/projects/[id]/files?folderId=` for that folder's files and updates the URL via `history.pushState` (with a `popstate` listener for back/forward).

**No-reload mutations:** BOM add/edit/delete (`BomTable.svelte`), file move/copy/upload (`FileList.svelte`/`UploadForm.svelte`), and folder create/delete (`FileBrowser.svelte`) all call their API routes via `fetch` and patch local `$state` on success instead of relying on a server redirect + full page reload. Because of this, the corresponding API routes (`api/bom/**`, `api/files/[fileId]/{move,copy}`, `api/projects/[id]/folders/**`, `api/projects/[id]/files/confirm`) return `Response.json(row)` (or `204`) on success instead of `redirect(...)`/a bare `'OK'` body — don't reintroduce `redirect()` in these routes, since no caller follows it as a page navigation anymore. `UploadForm.svelte` is now a child of `FileBrowser.svelte` (not a separate top-level island like the other components) specifically so it always sees the live `currentFolderId` as the user navigates folders client-side — as a sibling island it would only ever see the folder ID from the initial page load.

**Project page layout** (`src/pages/projects/[id].astro`): a single page, not split into separate Files/BOM routes — `.project-shell` is a two-column flex layout with `ProjectSidebar.astro` (project title, description, an inline members list — no separate `MembersPanel` component anymore, since the sidebar's member format (`display name (role)`, no email, no header borders) diverged enough from a general-purpose panel that it wasn't worth sharing — plus anchor nav links `#files`/`#bom`) beside a scrollable main column containing Files then BOM in sequence. The sidebar fold toggle is a plain button + `.collapsed` class (not `<details>`/`<summary>` — that read as folding when you clicked the title, which wasn't a clear affordance), persisted across page loads via `localStorage`. Nav links rely on plain browser anchor-scroll (`href="#files"`/`href="#bom"` matching `id`s on the Files `<h2>` and `BomTable.svelte`'s `<h2 id="bom">`) plus `position: sticky` on the sidebar so it stays visually in place while the anchor-scroll moves the page — there's no independent scroll container per column, so keep the sidebar's content short enough that it doesn't grow taller than the viewport, or the sticky effect stops looking like "only the main column scrolled."

**BOM table sizing** (`BomTable.svelte`): deliberately `table-layout: auto`, not `fixed` with a percentage `<colgroup>` — that was tried once and looked squished. Headers get `white-space: nowrap` so they never wrap. Display-mode rows (`tr.display-row`) truncate every cell (`nowrap` + `text-overflow: ellipsis`, capped at `max-width: 220px`) so every row is the same height by default — clicking anywhere on a row except the actions cell or a link toggles `expandedId`, which drops the truncation for that one row (`tr.display-row.expanded td`) so the full content wraps into view. The actions cell (`.row-actions`) is deliberately excluded from both the truncation and the row-click toggle, and its buttons get `white-space: nowrap; flex-shrink: 0` — without that, `table-layout: auto` can squeeze that column arbitrarily narrow and the button labels wrap one character per line. Edit-mode rows (no `display-row` class) are unaffected by any of this — they keep the focus-expand input overlay from before.

**Sidebar member roles** (`ProjectSidebar.astro`): each member row gets a `role-{owner,editor,viewer}` class colored via `--color-role-owner`/`-editor`/`-viewer` in `tokens.css` (muted red/blue/green) — add new roles to both places if the `project_members.role` check constraint ever grows.

**Type surface gotchas:**
- `src/env.d.ts` declares `App.Locals` (`supabase`, `user`) — it imports types, so it must stay wrapped in `declare global { ... } / export {}` or it stops being treated as ambient.
- Supabase's generated types can't express one-to-one cardinality through the `project_members` junction table; call sites use `.overrideTypes<...>()` as a manual workaround (see `src/pages/projects/[id].astro`). Don't "fix" this with a unique constraint on `user_id` alone — that would break multi-project membership.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)