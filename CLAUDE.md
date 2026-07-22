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