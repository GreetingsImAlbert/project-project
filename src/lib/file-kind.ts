// Which files the in-app viewer can show, and how. Shared by the viewer panel (so an
// unsupported file never even fires a request) and by the content endpoint (so the
// server doesn't stream arbitrary binaries back as text just because a client asked).

export type FileKind = 'markdown' | 'text' | 'unsupported';

// Text small enough to hand to the browser in one go. Decimal bytes, matching the rest
// of the project's byte math (see r2-quota.ts).
export const MAX_VIEWABLE_BYTES = 1_000_000;

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
