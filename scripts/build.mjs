import { readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (mode !== 'production' && mode !== 'staging') {
	console.error('Usage: node scripts/build.mjs <production|staging>');
	process.exit(1);
}
const cloudflareEnv = mode === 'production' ? 'prod' : 'staging';

// Production keeps using the existing .env until it is optionally split into
// .env.production. Staging never falls back to .env: that file currently points
// at production and Vite would otherwise load it for every mode.
const envFile = mode === 'production' && !existsSync('.env.production')
	? '.env'
	: `.env.${mode}`;

if (!existsSync(envFile)) {
	console.error(`Missing ${envFile}. Copy .env.${mode}.example and add this environment's public Supabase values.`);
	process.exit(1);
}

function parseEnvFile(path) {
	const values = {};
	for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value;
	}
	return values;
}

function jwtRole(value) {
	try {
		const payload = value.split('.')[1];
		if (!payload) return undefined;
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role;
	} catch {
		return undefined;
	}
}

const values = parseEnvFile(envFile);
const url = values.PUBLIC_SUPABASE_URL;
const key = values.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
	console.error(`${envFile} must define PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY.`);
	process.exit(1);
}

let parsedUrl;
try {
	parsedUrl = new URL(url);
} catch {
	console.error(`PUBLIC_SUPABASE_URL in ${envFile} is not a valid URL.`);
	process.exit(1);
}

if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('.supabase.co')) {
	console.error(`PUBLIC_SUPABASE_URL in ${envFile} must be an https://*.supabase.co URL.`);
	process.exit(1);
}

if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
	console.error(`PUBLIC_SUPABASE_PUBLISHABLE_KEY in ${envFile} is a private/service-role key and must never enter a browser build.`);
	process.exit(1);
}

if (/PROJECT_REF|PUBLISHABLE_OR_ANON_KEY/.test(`${url}\n${key}`)) {
	console.error(`${envFile} still contains example placeholders.`);
	process.exit(1);
}

if (mode === 'staging') {
	const productionFile = existsSync('.env.production') ? '.env.production' : '.env';
	if (existsSync(productionFile)) {
		const productionUrl = parseEnvFile(productionFile).PUBLIC_SUPABASE_URL;
		if (productionUrl && new URL(productionUrl).hostname === parsedUrl.hostname) {
			console.error(`Staging and production resolve to the same Supabase project (${parsedUrl.hostname}). Build stopped.`);
			process.exit(1);
		}
	}
}

// Explicit process values outrank Vite's shared .env file. This makes the checked
// mode-specific pair the exact pair Astro inlines into browser JavaScript.
const astroCli = resolve('node_modules', 'astro', 'bin', 'astro.mjs');
const result = spawnSync(process.execPath, [astroCli, 'build', '--mode', mode], {
	stdio: 'inherit',
	env: {
		...process.env,
		// Astro's Cloudflare adapter generates the Wrangler deployment config
		// during this build. Without this, every mode is flattened as default `p2`.
		CLOUDFLARE_ENV: cloudflareEnv,
		PUBLIC_SUPABASE_URL: url,
		PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
	},
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// The Cloudflare adapter copies local .dev.vars beside the generated server
// entry for local preview. Runtime Worker bindings replace it in deployments;
// retaining the copy would leave private credentials in the build artifact.
rmSync(resolve('dist', 'server', '.dev.vars'), { force: true });
