// Minimal Markdown -> HTML renderer for the file viewer panel.
//
// Hand-rolled rather than pulled from npm on purpose: the input is a file uploaded by
// any project member, and the output goes through `{@html}`. Every renderer worth using
// (marked, markdown-it, …) passes raw HTML in the source straight through, so it would
// need a sanitizer alongside it — two dependencies to render a preview. This one escapes
// the whole source first and only ever emits tags it built itself, so a `<script>` in a
// .md file renders as visible text instead of running. Same reasoning as item-url.ts:
// every href/src goes through `safeUrl`, so `javascript:` links can't be smuggled in.
//
// Supported: ATX + setext headings, fenced code, blockquotes, nested ordered/unordered
// lists (incl. task lists), GFM pipe tables, thematic breaks, paragraphs with hard
// breaks, and inline code/links/autolinks/images/bold/italic/strikethrough.

// Internal markers: NUL brackets a stashed inline-HTML index, SOH marks a hard break.
// Both are stripped from the source first so a file can't forge one.
const STASH = '\u0000';
const BREAK = '\u0001';

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Anything but http/https/mailto is dropped (the link renders as plain text). Relative
// paths are dropped too — there's nothing for `./other-file.md` to resolve against
// inside a preview panel, so a live-looking link that 404s is worse than no link.
function safeUrl(raw: string): string | null {
	const url = raw.trim();
	if (!url) return null;
	return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

// Inline HTML is parked in a store and swapped back in at the very end, so the emphasis
// and autolink passes can't chew through a URL sitting inside an attribute.
function stash(store: string[], html: string): string {
	store.push(html);
	return `${STASH}${store.length - 1}${STASH}`;
}

function unstash(text: string, store: string[]): string {
	return text.replace(/\u0000(\d+)\u0000/g, (whole, index: string) => store[Number(index)] ?? whole);
}

function inline(text: string, store: string[]): string {
	let out = escapeHtml(text);

	// Code spans first — their contents are literal and must escape every later pass.
	out = out.replace(/(`+)([^\n]*?)\1/g, (_whole, _ticks, code: string) => stash(store, `<code>${code}</code>`));

	out = out.replace(
		/!\[([^\]]*)\]\(\s*([^\s)\u0000]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
		(whole, alt: string, href: string, title?: string) => {
			const url = safeUrl(href);
			if (!url) return whole;
			const titleAttr = title ? ` title="${title}"` : '';
			return stash(store, `<img src="${url}" alt="${alt}"${titleAttr} loading="lazy" />`);
		}
	);

	// Only the opening tag is stashed; the link text stays inline so emphasis inside it
	// still gets processed.
	out = out.replace(
		/\[([^\]]*)\]\(\s*([^\s)\u0000]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
		(whole, label: string, href: string, title?: string) => {
			const url = safeUrl(href);
			if (!url) return whole;
			const titleAttr = title ? ` title="${title}"` : '';
			return `${stash(store, `<a href="${url}"${titleAttr} target="_blank" rel="noopener noreferrer">`)}${label}</a>`;
		}
	);

	// <https://…> autolinks (angle brackets are already escaped by now).
	out = out.replace(/&lt;((?:https?:\/\/|mailto:)(?:&amp;|[^\s&\u0000])+)&gt;/g, (whole, href: string) => {
		const url = safeUrl(href);
		if (!url) return whole;
		const label = href.replace(/^mailto:/i, '');
		return `${stash(store, `<a href="${url}" target="_blank" rel="noopener noreferrer">`)}${label}</a>`;
	});

	// Bare URLs. `&amp;` is spelled out because escaping already ran, and a query string
	// full of `&` is exactly where a bare link turns up. Trailing sentence punctuation is
	// left outside the link (`;` stays out of that set — it would eat the `&amp;`).
	out = out.replace(/(^|[\s(])(https?:\/\/(?:&amp;|[^\s<>&\u0000])+)/g, (whole, lead: string, href: string) => {
		const trailing = /[.,:!?)]+$/.exec(href)?.[0] ?? '';
		const target = trailing ? href.slice(0, -trailing.length) : href;
		const url = safeUrl(target);
		if (!url) return whole;
		const open = stash(store, `<a href="${url}" target="_blank" rel="noopener noreferrer">`);
		return `${lead}${open}${target}</a>${trailing}`;
	});

	out = out.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
	out = out.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
	out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[^\w\\])__([^\n]+?)__(?!\w)/g, '$1<strong>$2</strong>');
	out = out.replace(/(^|[^*\\])\*([^\s*][^\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
	// `_` only opens/closes emphasis at a word boundary, so snake_case_names survive.
	out = out.replace(/(^|[^\w\\])_([^\s_][^\n]*?)_(?!\w)/g, '$1<em>$2</em>');

	return out;
}

function isThematicBreak(line: string): boolean {
	return /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line);
}

interface ListLine {
	indent: number;
	ordered: boolean;
	marker: string;
	content: string;
}

function matchListLine(line: string): ListLine | null {
	const m = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
	if (!m) return null;
	return {
		indent: m[1].replace(/\t/g, '    ').length,
		ordered: /\d/.test(m[2]),
		marker: m[2],
		content: m[3],
	};
}

function isBlockStart(line: string): boolean {
	return (
		/^ {0,3}#{1,6}[ \t]/.test(line) ||
		/^ {0,3}(`{3,}|~{3,})/.test(line) ||
		/^ {0,3}>/.test(line) ||
		isThematicBreak(line) ||
		matchListLine(line) !== null
	);
}

function splitTableRow(row: string): string[] {
	let s = row.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

	const cells: string[] = [];
	let cur = '';
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '\\' && s[i + 1] === '|') {
			cur += '|';
			i++;
		} else if (s[i] === '|') {
			cells.push(cur);
			cur = '';
		} else {
			cur += s[i];
		}
	}
	cells.push(cur);
	return cells.map((c) => c.trim());
}

function isTableDelimiter(line: string): boolean {
	return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes('-');
}

function alignmentOf(cell: string): string {
	const left = cell.startsWith(':');
	const right = cell.endsWith(':');
	if (left && right) return ' style="text-align:center"';
	if (right) return ' style="text-align:right"';
	if (left) return ' style="text-align:left"';
	return '';
}

function renderListItems(
	items: ListLine[],
	start: number,
	indent: number,
	store: string[]
): { html: string; next: number } {
	const ordered = items[start].ordered;
	const parts: string[] = [];
	let i = start;

	while (i < items.length && items[i].indent >= indent) {
		if (items[i].indent > indent) {
			const sub = renderListItems(items, i, items[i].indent, store);
			// A nested list belongs inside the <li> above it.
			if (parts.length > 0) parts[parts.length - 1] += sub.html;
			else parts.push(sub.html);
			i = sub.next;
			continue;
		}

		if (items[i].ordered !== ordered) break;

		const raw = items[i].content.replace(/\n+/g, ' ');
		const task = /^\[([ xX])\][ \t]+(.*)$/.exec(raw);
		if (task) {
			const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
			parts.push(
				`<label class="md-task"><input type="checkbox" disabled${checked} />${inline(task[2], store)}</label>`
			);
		} else {
			parts.push(inline(raw, store));
		}
		i++;
	}

	const tag = ordered ? 'ol' : 'ul';
	const startNum = ordered ? parseInt(items[start].marker, 10) : 1;
	const startAttr = ordered && Number.isFinite(startNum) && startNum !== 1 ? ` start="${startNum}"` : '';
	const body = parts.map((p) => `<li>${p}</li>`).join('');
	return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i };
}

function renderBlocks(lines: string[], store: string[]): string {
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			const marker = fence[1][0];
			const length = fence[1].length;
			const info = fence[2].trim().split(/\s+/)[0] ?? '';
			const closer = new RegExp(`^ {0,3}\\${marker}{${length},}[ \\t]*$`);
			const body: string[] = [];
			i++;
			while (i < lines.length && !closer.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++; // the closing fence (or one past the end, for an unterminated block)
			const langClass = info ? ` class="language-${escapeHtml(info.replace(/[^\w.+-]/g, ''))}"` : '';
			out.push(`<pre><code${langClass}>${escapeHtml(body.join('\n'))}</code></pre>`);
			continue;
		}

		const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			out.push(`<h${level}>${inline(heading[2], store)}</h${level}>`);
			i++;
			continue;
		}

		if (isThematicBreak(line)) {
			out.push('<hr />');
			i++;
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const inner: string[] = [];
			while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
				inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
				i++;
			}
			out.push(`<blockquote>${renderBlocks(inner, store)}</blockquote>`);
			continue;
		}

		if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
			const headers = splitTableRow(line);
			const aligns = splitTableRow(lines[i + 1]).map(alignmentOf);
			i += 2;

			const rows: string[][] = [];
			while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
				rows.push(splitTableRow(lines[i]));
				i++;
			}

			const head = headers.map((c, n) => `<th${aligns[n] ?? ''}>${inline(c, store)}</th>`).join('');
			const body = rows
				.map((cells) => {
					const tds = headers
						.map((_h, n) => `<td${aligns[n] ?? ''}>${inline(cells[n] ?? '', store)}</td>`)
						.join('');
					return `<tr>${tds}</tr>`;
				})
				.join('');
			out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
			continue;
		}

		if (matchListLine(line)) {
			const items: ListLine[] = [];
			while (i < lines.length) {
				const current = lines[i];

				if (!current.trim()) {
					// One blank line between items keeps a single list; two end it.
					if (i + 1 < lines.length && matchListLine(lines[i + 1]) && !isThematicBreak(lines[i + 1])) {
						i++;
						continue;
					}
					break;
				}

				// `- - -` parses as a list item, so the break has to be checked first.
				if (isThematicBreak(current)) break;

				const item = matchListLine(current);
				if (item) {
					items.push(item);
					i++;
					continue;
				}

				// Indented continuation text folds into the item above it.
				if (items.length > 0 && /^[ \t]{2,}\S/.test(current)) {
					items[items.length - 1].content += `\n${current.trim()}`;
					i++;
					continue;
				}

				break;
			}

			// One gathered run can hold more than one list — `renderListItems` stops when
			// the marker type flips (a `1.` list right under a `-` list), so keep going
			// from where it left off instead of dropping the rest.
			let cursor = 0;
			while (cursor < items.length) {
				const built = renderListItems(items, cursor, items[cursor].indent, store);
				out.push(built.html);
				if (built.next <= cursor) break;
				cursor = built.next;
			}

			if (items.length > 0) continue;
		}

		// Paragraph — and setext headings, which only exist as a paragraph's underline.
		const para: string[] = [line];
		i++;
		let setext: 1 | 2 | null = null;

		while (i < lines.length) {
			const next = lines[i];
			if (!next.trim()) break;
			if (/^ {0,3}=+[ \t]*$/.test(next)) {
				setext = 1;
				i++;
				break;
			}
			if (/^ {0,3}-+[ \t]*$/.test(next)) {
				setext = 2;
				i++;
				break;
			}
			if (isBlockStart(next)) break;
			para.push(next);
			i++;
		}

		if (setext) {
			out.push(`<h${setext}>${inline(para.join(' '), store)}</h${setext}>`);
			continue;
		}

		// Two trailing spaces (or a trailing backslash) is a hard break. It becomes a
		// marker first because the inline passes would otherwise strip the spaces.
		const text = para.join('\n').replace(/(?: {2,}|\\)\n/g, `${BREAK}\n`);
		out.push(`<p>${inline(text, store).replace(/\u0001/g, '<br />')}</p>`);
	}

	return out.join('\n');
}

export function renderMarkdown(source: string): string {
	const store: string[] = [];
	const lines = source
		.replace(/\r\n?/g, '\n')
		.replace(/[\u0000\u0001]/g, '')
		.split('\n');
	return unstash(renderBlocks(lines, store), store);
}
