// Which files the in-app viewer can show, and how. Shared by the viewer panel (so an
// unsupported file never even fires a request) and by the content endpoint (so the
// server doesn't stream arbitrary binaries back as text just because a client asked).

export type FileKind = 'markdown' | 'text' | 'unsupported';

// Text small enough to hand to the browser in one go. Decimal bytes, matching the rest
// of the project's byte math (see r2-quota.ts).
export const MAX_VIEWABLE_BYTES = 1_000_000;

// R2 keys top out at 1024 bytes and already carry `${projectId}/${uuid}-`, so this
// leaves comfortable room while still ruling out a filename absurd enough to break
// the key or the file list's layout.
export const MAX_FILENAME_LENGTH = 255;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

const TEXT_EXTENSIONS = new Set([
	// plain / data
	'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml',
	'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'diff', 'patch', 'srt', 'vtt',
	// web
	'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'astro', 'svelte', 'vue',
	'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
	// general programming
	'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'cxx',
	'cc', 'hpp', 'hxx', 'cs', 'php', 'lua', 'pl', 'pm', 'r', 'jl', 'dart', 'sql',
	'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'make', 'cmake', 'gradle',
	// engineering-adjacent plain text
	'gcode', 'nc', 'scad', 'ino', 'm', 'f', 'f90', 'v', 'vhd', 'vhdl', 'tex', 'bib',
]);

// Files whose whole name is the type (no extension to go on).
const TEXT_BASENAMES = new Set([
	'makefile', 'dockerfile', 'license', 'licence', 'readme', 'changelog', 'authors',
	'notice', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc',
	'dockerignore', 'env', 'prettierrc', 'eslintrc', 'babelrc',
]);

// Same split rule as the file list uses for its name/extension display: a leading dot
// is part of the name (`.gitignore`), not an extension.
export function splitFilename(filename: string): { base: string; ext: string } {
	const idx = filename.lastIndexOf('.');
	if (idx <= 0) return { base: filename, ext: '' };
	return { base: filename.slice(0, idx), ext: filename.slice(idx) };
}

// Extension -> Prism/refractor language id, for the viewer's syntax highlighting. Kept
// here rather than in highlight.ts because this file already owns the extension list and
// stays dependency-free (the server imports it too); highlight.ts owns the grammars.
// `null`/absent means "no grammar worth loading" — plain text, data with no syntax to
// speak of (.csv, .log), or a type Prism has no grammar for (.scad). That is a normal
// outcome, not a failure: the viewer just leaves the <pre> unhighlighted.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	// plain / data
	json: 'json', jsonc: 'json', xml: 'markup', yaml: 'yaml', yml: 'yaml',
	toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
	env: 'bash', diff: 'diff', patch: 'diff',
	// web
	html: 'markup', htm: 'markup', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
	svg: 'markup', astro: 'markup', svelte: 'markup', vue: 'markup',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
	ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
	// general programming
	py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
	kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp',
	hpp: 'cpp', hxx: 'cpp', cs: 'csharp', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl',
	r: 'r', jl: 'julia', dart: 'dart', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
	fish: 'bash', ps1: 'powershell', bat: 'batch', cmd: 'batch', make: 'makefile',
	cmake: 'cmake', gradle: 'groovy',
	// engineering-adjacent
	gcode: 'gcode', nc: 'gcode', ino: 'arduino', m: 'matlab', f: 'fortran',
	f90: 'fortran', v: 'verilog', vhd: 'vhdl', vhdl: 'vhdl', tex: 'latex',
	// markdown, for fenced code blocks inside a rendered .md
	md: 'markdown', markdown: 'markdown',
};

const LANGUAGE_BY_BASENAME: Record<string, string> = {
	makefile: 'makefile', dockerfile: 'docker', editorconfig: 'ini', npmrc: 'ini',
	env: 'bash', prettierrc: 'json', eslintrc: 'json', babelrc: 'json',
};

// Own-property lookup, not `map[key] ?? null`. The key comes from a user-supplied
// filename, and a plain object inherits from Object.prototype — so `notes.constructor`
// would resolve to the Object *function* and `notes.__proto__` to Object.prototype, both
// truthy enough to sail past `??` and be returned as if they were a language name.
function lookup(map: Record<string, string>, key: string): string | null {
	return Object.hasOwn(map, key) ? map[key] : null;
}

export function languageFor(filename: string): string | null {
	const name = filename.trim().toLowerCase();
	const { ext } = splitFilename(name);

	if (ext) return lookup(LANGUAGE_BY_EXTENSION, ext.slice(1));
	return lookup(LANGUAGE_BY_BASENAME, name.replace(/^\./, ''));
}

export function fileKind(filename: string): FileKind {
	const name = filename.trim().toLowerCase();
	const { ext } = splitFilename(name);

	if (ext) {
		const bare = ext.slice(1);
		if (MARKDOWN_EXTENSIONS.has(bare)) return 'markdown';
		if (TEXT_EXTENSIONS.has(bare)) return 'text';
		return 'unsupported';
	}

	// No extension: `Dockerfile`, `.gitignore`, `LICENSE`, …
	if (TEXT_BASENAMES.has(name.replace(/^\./, ''))) return 'text';
	return 'unsupported';
}
