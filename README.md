# P2

P2 is a collaborative project manager built specifically for mechanical engineering projects. It brings planning, documentation, files, and costs into one workspace so a team can track both the work and the physical resources behind it.

## Features

- Task tracking
- Shared files and folders with previews
- Tabbed project journals with a shared `JOURNAL.md`, optional personal journals, per-journal drafts and history, visibility controls, and Manila-midnight finalization
- Expense tracking
- Forum for collaboration with other users

## Stack

Astro, Svelte, TypeScript, Supabase, Cloudflare Workers/R2, and Three.js.

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run update-types
npx wrangler types
npm run dev:staging
```

Production and staging builds are available through `npm run build` and `npm run build:staging`.

Project exports use a versioned manifest that preserves journal files, protected-folder metadata, and journal-specific drafts. Older V1/V2 exports are still accepted and imported as the shared Group journal.

Before opening a change, run the relevant checks:

```sh
npx astro check
npx tsc --noEmit
npx sv check
npm test
npm run build:staging
```
