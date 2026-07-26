<script lang="ts">
	import { tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { fileKind, languageFor, splitFilename } from '../lib/file-kind';
	import { renderMarkdown } from '../lib/markdown';
	// Type-only, so it doesn't drag the highlighter into this component's bundle — the
	// grammars stay behind the dynamic imports below.
	import type { RootContent } from 'hast';

	interface ViewerFile {
		id: string;
		filename: string;
	}

	let {
		file,
		onClose,
		zIndex = 50,
		closeOnEscape = true,
		editOnOpen = false,
		onWidthChange,
		onDirtyChange,
		onFileRestore,
		onSaved,
	}: {
		file: ViewerFile | null;
		onClose: () => void;
		// Raised when the panel opens over something that already has its own overlay
		// (MyFilesModal's backdrop sits at 100).
		zIndex?: number;
		// Off when the host already owns Escape: two window listeners both firing on the
		// same keydown would close the panel and its host in one press, and which of the
		// two runs first isn't something either component can rely on.
		closeOnEscape?: boolean;
		// Drop straight into the editor once this file's content has loaded, instead of
		// showing it read-only first. Set by hosts that just created the file, where there
		// is nothing to read yet and Edit is the only reason the panel opened. Read when the
		// file id changes, so it can't turn a later open into an edit on its own.
		editOnOpen?: boolean;
		// How much of the right edge the panel is covering right now (0 when closed), so a
		// host that overlays content of its own can keep it clear of the panel. Fires on
		// open, on close, and continuously while the handle is dragged.
		onWidthChange?: (width: number) => void;
		// True while the editor holds changes that aren't saved yet. Hosts use it to stop
		// their own close paths (a backdrop click, their own Escape handling) from
		// throwing the buffer away without asking.
		onDirtyChange?: (dirty: boolean) => void;
		// The panel can't refuse a `file` prop it doesn't like, so when the user declines to
		// discard an edit it asks the host to put its selection back to the file given here.
		onFileRestore?: (fileId: string) => void;
		// A save changed the file's size on disk: hosts keep their own row/quota figures in
		// step rather than re-reading them.
		onSaved?: (fileId: string, sizeBytes: number) => void;
	} = $props();

	const MIN_WIDTH = 280;

	// Kept across opens, so a width the user dragged to survives closing the panel.
	// `sized` is deliberately not $state — the effect below writes `width`, and reading
	// it there too would make the effect re-run on its own write.
	let width = $state<number | null>(null);
	let sized = false;
	let resizing = $state(false);
	let panelEl = $state<HTMLElement | null>(null);

	let content = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let downloading = $state(false);
	// Separate from `error` so a failed download doesn't blank out a preview that loaded.
	let downloadError = $state<string | null>(null);

	// Whether the server would accept a save from this user for this file. Answered by the
	// content endpoint rather than passed in, because the Dashboard's My-files modal spans
	// projects and doesn't know the caller's role in any of them.
	let canEdit = $state(false);
	// The loaded object's R2 ETag, handed back on save so the server can tell whether
	// someone else wrote to the file in the meantime.
	let etag = $state<string | null>(null);

	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	// A save rejected because the stored file moved on. Worth its own flag: it's the one
	// save failure with a way out (reload and start from the current version).
	let conflict = $state(false);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	let kind = $derived(file ? fileKind(file.filename) : 'unsupported');
	let html = $derived(kind === 'markdown' && content !== null ? renderMarkdown(content) : '');
	let dirty = $derived(editing && draft !== (content ?? ''));

	// Syntax-highlighted tokens for the read-only view, or null for "render it plainly" —
	// which covers a file type with no grammar, a chunk that hasn't downloaded yet, and a
	// grammar that failed. All three are fine outcomes, so none of them surface as errors.
	let tokens = $state<RootContent[] | null>(null);
	let language = $derived(file ? languageFor(file.filename) : null);
	let mdBodyEl = $state<HTMLElement | null>(null);
	// Same job as `requestSeq` does for content: a highlight resolving after the user has
	// moved on must not paint itself over the file that's on screen now.
	let highlightSeq = 0;

	// refractor gives every token node a className array (`['token', 'keyword']`). Pulled
	// out of the snippet below only because that has to stay on one line.
	function tokenClass(node: Extract<RootContent, { type: 'element' }>): string {
		const value = node.properties?.className;
		return Array.isArray(value) ? value.join(' ') : '';
	}

	// Bumped per open so a slow response for a file the user already navigated away
	// from can't paint itself into the panel.
	let requestSeq = 0;
	let loadedId: string | null = null;
	// Latched from editOnOpen at the moment a new file arrives, and spent by the load that
	// follows — the prop may well have gone back to false by the time the content lands.
	let autoEditPending = false;

	function clampWidth(px: number): number {
		const max = Math.max(MIN_WIDTH, window.innerWidth - 80);
		return Math.min(Math.max(px, MIN_WIDTH), max);
	}

	// Half the main column, not half the window — the sidebar isn't part of what the
	// panel is covering. `.project-main` is authored in ProjectShell.astro, so it's
	// looked up rather than bound.
	function defaultWidth(): number {
		const main = document.querySelector('.project-main');
		const base = main ? main.clientWidth : window.innerWidth;
		return clampWidth(Math.round(base / 2));
	}

	function resetEditor() {
		editing = false;
		draft = '';
		saving = false;
		saveError = null;
		conflict = false;
		canEdit = false;
		etag = null;
	}

	function loadContent(current: ViewerFile) {
		content = null;
		error = null;
		downloadError = null;

		if (fileKind(current.filename) === 'unsupported') return;

		const seq = ++requestSeq;
		loading = true;

		fetch(`/api/files/${current.id}/content`)
			.then(async (res) => {
				if (seq !== requestSeq) return;
				if (!res.ok) {
					error = await res.text();
				} else {
					const data = (await res.json()) as { content: string; canEdit: boolean; etag: string | null };
					content = data.content;
					canEdit = data.canEdit;
					etag = data.etag;
				}
				loading = false;

				// Spent whether or not it can be honoured — a file the server won't let this
				// user edit shouldn't stay armed for the next one that loads.
				if (autoEditPending) {
					autoEditPending = false;
					if (content !== null && canEdit) startEditing();
				}
			})
			.catch(() => {
				if (seq !== requestSeq) return;
				error = 'Could not load this file';
				loading = false;
			});
	}

	$effect(() => {
		const current = file;

		if (!current) {
			loadedId = null;
			autoEditPending = false;
			// Every path that closes the panel has already asked about an unsaved buffer, so
			// by here it's been abandoned on purpose — and leaving `dirty` true would keep
			// the host's own Escape/close paths blocked long after the panel was gone.
			resetEditor();
			return;
		}

		if (!sized) {
			sized = true;
			width = defaultWidth();
		}

		if (current.id === loadedId) return;

		// Another file was clicked while an edit was still unsaved. `dirty` is only read
		// once the id has actually changed, so an ordinary keystroke doesn't re-run this.
		if (loadedId !== null && dirty) {
			const previousId = loadedId;
			if (!confirm('Discard your unsaved changes to this file?')) {
				onFileRestore?.(previousId);
				return;
			}
		}

		loadedId = current.id;
		resetEditor();
		autoEditPending = editOnOpen;
		loadContent(current);
	});

	// Highlighting is driven off `content` rather than hooked into loadContent(), so every
	// way the text can change is covered by one path — first load, a save writing the
	// buffer back, and a post-conflict reload.
	$effect(() => {
		const source = content;
		const lang = language;
		const highlightable = kind === 'text' && source !== null && lang !== null;

		// Cleared synchronously: the plain <pre> renders immediately and is upgraded when
		// the chunk lands, so a slow download delays the highlight, never the preview.
		tokens = null;
		if (!highlightable) return;

		const seq = ++highlightSeq;
		import('../lib/highlight')
			.then(({ highlightCode }) => {
				if (seq !== highlightSeq) return;
				tokens = highlightCode(source, lang);
			})
			.catch(() => {
				// Offline, or the chunk failed to load. The plain text is already on screen.
			});
	});

	// Fenced code inside rendered Markdown. It arrives through {@html}, so it isn't part of
	// any component template and the snippet below can't reach it — this is the one place
	// the tokens have to be turned into real DOM nodes and put in by hand.
	$effect(() => {
		const el = mdBodyEl;
		if (!el || !html) return;

		const blocks = Array.from(el.querySelectorAll('pre > code[class*="language-"]'));
		if (blocks.length === 0) return;

		let cancelled = false;

		import('../lib/highlight')
			.then(({ highlightCode, hastToDom }) => {
				if (cancelled) return;

				for (const block of blocks) {
					// The rendered Markdown may have been replaced while the chunk downloaded.
					if (!block.isConnected) continue;

					const match = /(?:^|\s)language-([\w.+-]+)/.exec(block.className);
					if (!match) continue;

					const nodes = highlightCode(block.textContent ?? '', match[1]);
					if (nodes) block.replaceChildren(hastToDom(nodes));
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		onWidthChange?.(file && width !== null ? width : 0);
	});

	$effect(() => {
		onDirtyChange?.(dirty);
	});

	async function download() {
		if (!file) return;

		downloading = true;
		downloadError = null;
		const res = await fetch(`/api/files/${file.id}/download-url`);

		if (!res.ok) {
			downloadError = 'Failed to get download link';
			downloading = false;
			return;
		}

		const { downloadUrl } = await res.json();
		window.location.href = downloadUrl;
		downloading = false;
	}

	async function startEditing() {
		if (content === null || !canEdit) return;

		draft = content;
		editing = true;
		saveError = null;
		conflict = false;

		await tick();
		if (!textareaEl) return;

		// Assigning a textarea's value leaves the caret sitting at the end of the text, so
		// focusing it scrolls straight to the bottom of the file. Put the caret (and the
		// view) back at the top, where the reader just was.
		textareaEl.setSelectionRange(0, 0);
		textareaEl.focus();
		textareaEl.scrollTop = 0;
	}

	function cancelEditing() {
		if (dirty && !confirm('Discard your unsaved changes?')) return;
		resetEditingOnly();
	}

	// Everything resetEditor() clears except canEdit/etag, which survive a cancel — the
	// file itself hasn't been reloaded, so what the server said about it still holds.
	function resetEditingOnly() {
		editing = false;
		draft = '';
		saveError = null;
		conflict = false;
	}

	async function save() {
		if (!file || saving) return;

		saving = true;
		saveError = null;
		conflict = false;

		const target = file;
		const saved = draft;

		try {
			const res = await fetch(`/api/files/${target.id}/content`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: saved, etag }),
			});

			if (!res.ok) {
				conflict = res.status === 409;
				saveError = await res.text();
				return;
			}

			const data = (await res.json()) as { sizeBytes: number; etag: string | null };

			// The panel may have been pointed at a different file while the request was in
			// flight; the write still happened, so the host is told either way, but nothing
			// gets painted over whatever is on screen now.
			if (file?.id === target.id) {
				content = saved;
				etag = data.etag;
				resetEditingOnly();
			}

			onSaved?.(target.id, data.sizeBytes);
		} catch {
			saveError = 'Could not save this file';
		} finally {
			saving = false;
		}
	}

	// After a conflict: throw the draft away and start again from what's in storage now.
	function reloadFromStorage() {
		if (!file) return;
		if (dirty && !confirm('Discard your unsaved changes and reload this file?')) return;

		resetEditingOnly();
		loadContent(file);
	}

	function editorKeydown(e: KeyboardEvent) {
		// Ctrl/Cmd+S is what people press in an editor, and the browser's own Save-page
		// dialog is never what they meant.
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			save();
			return;
		}

		// Tab indents instead of leaving the field — this is a code/text editor, and
		// Escape isn't bound while editing, so Cancel/Save stay reachable from the
		// keyboard via shift+tab out of the textarea.
		if (e.key === 'Tab' && !e.shiftKey) {
			e.preventDefault();
			const el = e.currentTarget as HTMLTextAreaElement;
			const { selectionStart, selectionEnd } = el;
			draft = `${draft.slice(0, selectionStart)}\t${draft.slice(selectionEnd)}`;
			tick().then(() => el.setSelectionRange(selectionStart + 1, selectionStart + 1));
		}
	}

	function requestClose() {
		if (dirty && !confirm('Discard your unsaved changes?')) return;
		onClose();
	}

	function startResize(e: PointerEvent) {
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		resizing = true;
		document.body.style.userSelect = 'none';
	}

	function moveResize(e: PointerEvent) {
		if (!resizing) return;
		width = clampWidth(window.innerWidth - e.clientX);
	}

	function endResize(e: PointerEvent) {
		if (!resizing) return;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		resizing = false;
		document.body.style.userSelect = '';
	}

	function resizeKeys(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		width = clampWidth((width ?? defaultWidth()) + (e.key === 'ArrowLeft' ? 24 : -24));
	}

	function onWindowKeydown(e: KeyboardEvent) {
		// Escape is deliberately inert while there are unsaved changes, here and in every
		// host: a buffer only ever leaves through Save or Cancel, so it can't depend on
		// which window listener happens to have been registered first.
		if (dirty) return;
		if (e.key === 'Escape' && file && closeOnEscape) onClose();
	}

	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (!dirty) return;
		e.preventDefault();
	}

	// The ancestor chain the press travelled, and what was open at the time. Both are read
	// by onWindowClick below; see the reasoning there.
	let pressPath: EventTarget[] | null = null;
	let fileAtPress: ViewerFile | null = null;

	function onWindowPointerDown(e: PointerEvent) {
		// The whole path, not just e.target: a button that swaps itself out of the DOM when
		// clicked (Edit becomes Save/Cancel, and back) is already detached by the time the
		// click reaches the window, so asking whether the panel still contains it answers
		// no — and the panel would close on its own Edit button. An event's path is fixed
		// when it's dispatched, so it still names the panel either way.
		pressPath = e.composedPath();
		fileAtPress = file;
	}

	function onWindowClick(e: MouseEvent) {
		// Both press values are consumed here, not just read: a keyboard-activated click has
		// no pointerdown of its own, and stale values from the last real press would make it
		// look like a click on some other element, on some other file.
		const path = pressPath ?? e.composedPath();
		const openAtPress = fileAtPress;
		pressPath = null;
		fileAtPress = null;

		if (!file) return;

		// An unsaved buffer isn't something a stray click gets to discard.
		if (dirty) return;

		// The click that opened this file arrives here too — it bubbles to the window after
		// the list's own handler has already swapped `file` — and closing on it would make
		// files in the list un-openable.
		if (file.id !== openAtPress?.id) return;

		// Where the press started, not where the click landed: a resize drag that starts on
		// the handle and ends out over the page reads as a click on their common ancestor,
		// and selecting text in the panel can end anywhere at all.
		if (panelEl && path.includes(panelEl)) return;

		onClose();
	}

	// A width dragged out on a wide window would overhang a narrower one.
	function onWindowResize() {
		if (width !== null) width = clampWidth(width);
	}
</script>

<svelte:window
	onkeydown={onWindowKeydown}
	onresize={onWindowResize}
	onpointerdown={onWindowPointerDown}
	onclick={onWindowClick}
	onbeforeunload={onBeforeUnload}
/>

<!-- The highlighter's token tree, rendered as ordinary markup. Text goes through Svelte's
     own interpolation, so the file's contents are escaped by the framework and nothing here
     needs {@html} or a sanitizer beside it. Deliberately written on one line: this renders
     inside a <pre>, where any newline or indentation between these tags would become a real
     text node and corrupt the code's own whitespace. -->
{#snippet syntax(nodes: RootContent[])}{#each nodes as node}{#if node.type === 'text'}{node.value}{:else if node.type === 'element'}<span class={tokenClass(node)}>{@render syntax(node.children)}</span>{/if}{/each}{/snippet}

{#if file}
	{@const parts = splitFilename(file.filename)}
	<aside
		bind:this={panelEl}
		class="viewer"
		style={`width: ${width ?? 480}px; z-index: ${zIndex}`}
		transition:fly={{ x: width ?? 480, duration: 180 }}
		aria-label={`Preview of ${file.filename}`}
	>
		<div
			class="resize-handle"
			class:resizing
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize preview panel"
			tabindex="0"
			onpointerdown={startResize}
			onpointermove={moveResize}
			onpointerup={endResize}
			onpointercancel={endResize}
			onkeydown={resizeKeys}
		></div>

		<header class="viewer-head">
			<span class="viewer-name" title={file.filename}>
				{parts.base}{#if parts.ext}<span class="muted">{parts.ext}</span>{/if}{#if dirty}<span class="dirty-dot" title="Unsaved changes">•</span>{/if}
			</span>

			<div class="viewer-actions">
				{#if editing}
					<button type="button" class="btn-plain" onclick={save} disabled={saving || !dirty}>
						{saving ? 'Saving…' : 'Save'}
					</button>
					<button type="button" class="btn-plain" onclick={cancelEditing} disabled={saving}>Cancel</button>
				{:else}
					<button
						type="button"
						class="btn-plain"
						onclick={startEditing}
						disabled={!canEdit || content === null}
						title={canEdit ? 'Edit this file' : 'You need edit access to this project'}
					>
						Edit
					</button>
					<button type="button" class="btn-plain" onclick={download} disabled={downloading}>
						{downloading ? 'Preparing…' : 'Download'}
					</button>
				{/if}
				<button type="button" class="btn-plain close-btn" aria-label="Close preview" onclick={requestClose}>✕</button>
			</div>
		</header>

		{#if downloadError}
			<p class="download-error">{downloadError}</p>
		{/if}

		{#if saveError}
			<p class="save-error">
				{saveError}
				{#if conflict}
					<button type="button" class="btn-plain reload-btn" onclick={reloadFromStorage}>Reload</button>
				{/if}
			</p>
		{/if}

		<div class="viewer-body" class:editing>
			{#if kind === 'unsupported'}
				<p class="viewer-note">Unsupported</p>
				<p class="viewer-note muted">This file can't be previewed. Download it to open it locally.</p>
			{:else if loading}
				<p class="viewer-note muted">Loading…</p>
			{:else if error}
				<p class="viewer-note error">{error}</p>
			{:else if editing}
				<textarea
					bind:this={textareaEl}
					bind:value={draft}
					class="editor"
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					aria-label={`Edit ${file.filename}`}
					onkeydown={editorKeydown}
				></textarea>
			{:else if content !== null}
				{#if kind === 'markdown'}
					<!-- renderMarkdown escapes the whole source and only emits tags it built
					     itself, so an uploaded .md can't inject markup here. -->
					<div class="md-body" bind:this={mdBodyEl}>{@html html}</div>
				{:else}
					<pre class="text-body">{#if tokens}{@render syntax(tokens)}{:else}{content}{/if}</pre>
				{/if}
			{/if}
		</div>
	</aside>
{/if}

<style>
	.viewer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		/* z-index comes in inline, from the zIndex prop. */
		display: flex;
		flex-direction: column;
		max-width: 100vw;
		background: var(--color-bg);
		border-left: 1px solid var(--color-border-strong);
		/* Set, not inherited: the panel is fixed, but `color` still comes down from
		   whatever mounted it, and MyFilesModal's host line is muted. */
		color: var(--color-fg);
	}

	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -3px;
		width: 7px;
		cursor: col-resize;
		touch-action: none;
	}

	.resize-handle:hover,
	.resize-handle:focus-visible,
	.resize-handle.resizing {
		background: var(--color-border-strong);
		outline: none;
	}

	.viewer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--color-border-strong);
	}

	.viewer-name {
		font-size: 0.85rem;
		/* min-width:0 — a flex item won't shrink below its content without it, and the
		   ellipsis never kicks in. */
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.download-error,
	.save-error {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--color-border);
		color: var(--color-danger);
		font-size: 0.8rem;
	}

	.viewer-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: 0 0 auto;
	}

	.viewer-actions button {
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
	}

	.close-btn {
		line-height: 1;
	}

	.viewer-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: var(--space-3);
	}

	/* The textarea sizes itself to the body, so the body must not scroll on its own —
	   the scrollbar belongs to the editor. */
	.viewer-body.editing {
		display: flex;
		overflow: hidden;
	}

	.editor {
		flex: 1;
		min-height: 0;
		width: 100%;
		box-sizing: border-box;
		resize: none;
		margin: 0;
		padding: var(--space-2);
		font-family: inherit;
		font-size: 0.78rem;
		line-height: 1.6;
		tab-size: 4;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.dirty-dot {
		color: var(--color-danger);
		padding-left: var(--space-1);
	}

	.reload-btn {
		margin-left: var(--space-2);
		font-size: 0.75rem;
		padding: 0 var(--space-1);
	}

	.viewer-note {
		margin: 0 0 var(--space-2);
		font-size: 0.85rem;
	}

	.viewer-note.error {
		color: var(--color-danger);
	}

	.text-body {
		margin: 0;
		font-size: 0.78rem;
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		tab-size: 4;
	}

	/* Prism's token classes onto this project's theme tokens, for both the plain <pre> and
	   fenced code inside rendered Markdown. :global because neither set of spans exists in
	   this component's template at compile time — one comes from a snippet with a dynamic
	   class, the other is built as DOM nodes — and Svelte would prune the rules otherwise.
	   Kept under .text-body/.md-body so they can't leak out of the panel.

	   Only the six groups the tokens define, with the many Prism classes that fall into
	   each aliased on. Anything unlisted just inherits the body colour, which is the same
	   thing the viewer did before highlighting existed. */
	.text-body :global(.token.comment),
	.text-body :global(.token.prolog),
	.text-body :global(.token.doctype),
	.text-body :global(.token.cdata),
	.md-body :global(.token.comment),
	.md-body :global(.token.prolog),
	.md-body :global(.token.doctype),
	.md-body :global(.token.cdata) {
		color: var(--color-syntax-comment);
		font-style: italic;
	}

	.text-body :global(.token.keyword),
	.text-body :global(.token.atrule),
	.text-body :global(.token.important),
	.text-body :global(.token.rule),
	.text-body :global(.token.tag),
	.text-body :global(.token.selector),
	.md-body :global(.token.keyword),
	.md-body :global(.token.atrule),
	.md-body :global(.token.important),
	.md-body :global(.token.rule),
	.md-body :global(.token.tag),
	.md-body :global(.token.selector) {
		color: var(--color-syntax-keyword);
	}

	.text-body :global(.token.string),
	.text-body :global(.token.char),
	.text-body :global(.token.attr-value),
	.text-body :global(.token.regex),
	.text-body :global(.token.inserted),
	.md-body :global(.token.string),
	.md-body :global(.token.char),
	.md-body :global(.token.attr-value),
	.md-body :global(.token.regex),
	.md-body :global(.token.inserted) {
		color: var(--color-syntax-string);
	}

	.text-body :global(.token.number),
	.text-body :global(.token.boolean),
	.text-body :global(.token.constant),
	.text-body :global(.token.symbol),
	.text-body :global(.token.deleted),
	.md-body :global(.token.number),
	.md-body :global(.token.boolean),
	.md-body :global(.token.constant),
	.md-body :global(.token.symbol),
	.md-body :global(.token.deleted) {
		color: var(--color-syntax-number);
	}

	.text-body :global(.token.function),
	.text-body :global(.token.class-name),
	.text-body :global(.token.attr-name),
	.text-body :global(.token.property),
	.text-body :global(.token.variable),
	.md-body :global(.token.function),
	.md-body :global(.token.class-name),
	.md-body :global(.token.attr-name),
	.md-body :global(.token.property),
	.md-body :global(.token.variable) {
		color: var(--color-syntax-function);
	}

	.text-body :global(.token.punctuation),
	.text-body :global(.token.operator),
	.md-body :global(.token.punctuation),
	.md-body :global(.token.operator) {
		color: var(--color-syntax-punct);
	}

	/* Markdown output goes in via {@html}, which Svelte's scoping never touches — every
	   rule below has to be :global, kept under .md-body so it can't leak out. */

	.md-body {
		font-size: 0.85rem;
	}

	.md-body :global(> *:first-child) {
		margin-top: 0;
	}

	.md-body :global(h1),
	.md-body :global(h2),
	.md-body :global(h3),
	.md-body :global(h4),
	.md-body :global(h5),
	.md-body :global(h6) {
		margin: var(--space-5) 0 var(--space-3);
		padding: 0;
		border: none;
		font-weight: 700;
		line-height: 1.3;
	}

	.md-body :global(h1) {
		font-size: 1.25rem;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--color-border-strong);
	}

	.md-body :global(h2) {
		font-size: 1.05rem;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--color-border);
	}

	.md-body :global(h3) { font-size: 0.95rem; }
	.md-body :global(h4),
	.md-body :global(h5),
	.md-body :global(h6) { font-size: 0.85rem; }

	.md-body :global(p) {
		margin: 0 0 var(--space-3);
	}

	.md-body :global(a) {
		color: var(--color-link);
		border-bottom: 1px solid currentColor;
	}

	.md-body :global(ul),
	.md-body :global(ol) {
		margin: 0 0 var(--space-3);
		padding-left: var(--space-5);
	}

	.md-body :global(li) {
		margin-bottom: var(--space-1);
	}

	.md-body :global(li > ul),
	.md-body :global(li > ol) {
		margin: var(--space-1) 0 0;
	}

	.md-body :global(.md-task) {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.md-body :global(code) {
		background: var(--color-highlight);
		border: 1px solid var(--color-border);
		padding: 0 3px;
		font-size: 0.95em;
	}

	.md-body :global(pre) {
		margin: 0 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		background: var(--color-highlight);
		overflow-x: auto;
		font-size: 0.78rem;
		line-height: 1.6;
		tab-size: 4;
	}

	.md-body :global(pre code) {
		background: none;
		border: none;
		padding: 0;
		font-size: inherit;
	}

	.md-body :global(blockquote) {
		margin: 0 0 var(--space-3);
		padding-left: var(--space-3);
		border-left: 2px solid var(--color-border-strong);
		color: var(--color-muted);
	}

	.md-body :global(blockquote > *:last-child) {
		margin-bottom: 0;
	}

	.md-body :global(hr) {
		margin: var(--space-4) 0;
		border: none;
		border-top: 1px solid var(--color-border);
	}

	.md-body :global(table) {
		display: block;
		width: max-content;
		max-width: 100%;
		overflow-x: auto;
		margin: 0 0 var(--space-3);
		border: 1px solid var(--color-border-strong);
		font-size: 0.78rem;
	}

	.md-body :global(th),
	.md-body :global(td) {
		padding: 3px var(--space-2);
		border-bottom: 1px solid var(--color-border);
		border-right: 1px solid var(--color-border);
	}

	.md-body :global(th:last-child),
	.md-body :global(td:last-child) {
		border-right: none;
	}

	.md-body :global(thead th) {
		background: var(--color-highlight);
		border-bottom: 1px solid var(--color-border-strong);
	}

	.md-body :global(img) {
		max-width: 100%;
		height: auto;
	}

	/* Below the tablet breakpoint the main column is already full-bleed, so a
	   half-width panel has nothing useful to sit beside. !important is the only way
	   to beat the inline width the drag handle writes. */
	@media (max-width: 768px) {
		.viewer {
			width: 100vw !important;
		}

		.resize-handle {
			display: none;
		}
	}
</style>
