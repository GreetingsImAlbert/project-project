# P2

P2 is a collaborative project manager built specifically for mechanical engineering projects. It brings planning, documentation, files, and costs into one workspace so a team can track both the work and the physical resources behind it.

## Features

- Task tracking
- Shared files and folders with previews
- Project journal
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
