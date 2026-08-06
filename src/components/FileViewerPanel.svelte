<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { fileKind, isTextKind, languageFor, splitFilename } from '../lib/file-kind';
	import { renderMarkdown } from '../lib/markdown';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import type { ViewerTab } from '../lib/viewer-tabs';
	// Type-only, so it doesn't drag the highlighter into this component's bundle — the
	// grammars stay behind the dynamic imports below.
	import type { RootContent } from 'hast';

	let {
		file,
		tabs,
		onClose,
		onTabSelect,
		onTabClose,
		zIndex = 50,
		editOnOpen = false,
		onWidthChange,
		onDirtyChange,
		onFileRestore,
		onSaved,
	}: {
		file: ViewerTab | null;
		tabs: ViewerTab[];
		onClose: () => void;
		onTabSelect: (fileId: string) => void;
		onTabClose: (fileId: string) => void;
		// Raised when the panel opens over something that already has its own overlay
		// (MyFilesModal's backdrop sits at 100).
		zIndex?: number;
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
	// Below this width the preview is no longer useful, so resizing it farther closes it.
	const CLOSE_WIDTH = 240;

	// Kept across opens, so a width the user dragged to survives closing the panel.
	// `sized` is deliberately not $state — the effect below writes `width`, and reading
	// it there too would make the effect re-run on its own write.
	let width = $state<number | null>(null);
	let sized = false;
	let resizing = $state(false);
	let resizeClosePending = false;

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
	let contentRequest: AbortController | null = null;
	let loadedId: string | null = null;
	let skipDirtyPromptForId: string | null = null;
	// Latched from editOnOpen at the moment a new file arrives, and spent by the load that
	// follows — the prop may well have gone back to false by the time the content lands.
	let autoEditPending = false;

	function clampWidth(px: number): number {
		const max = Math.max(MIN_WIDTH, window.innerWidth - 80);
		return Math.min(Math.max(px, MIN_WIDTH), max);
	}

	// Half the main column, not half the window — the sidebar isn't part of what the
	// panel is covering. `.project-main` is authored in BaseLayout.astro, so it's
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

	function loadContent(current: ViewerTab) {
		contentRequest?.abort();
		content = null;
		error = null;
		downloadError = null;

		// Meshes never come through here: CadViewer streams the raw bytes from its own
		// endpoint, and decoding an STL as UTF-8 would only produce a 415 anyway.
		if (!isTextKind(fileKind(current.filename))) return;

		const seq = ++requestSeq;
		const controller = new AbortController();
		contentRequest = controller;
		loading = true;

		fetch(`/api/files/${current.id}/content`, { signal: controller.signal })
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
			.catch((requestError) => {
				if (seq !== requestSeq) return;
				if (controller.signal.aborted || (requestError instanceof DOMException && requestError.name === 'AbortError')) return;
				error = 'Could not load this file';
				loading = false;
			});
	}

	$effect(() => {
		const current = file;

		if (!current) {
			requestSeq += 1;
			contentRequest?.abort();
			contentRequest = null;
			loadedId = null;
			skipDirtyPromptForId = null;
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
		if (loadedId !== null && dirty && skipDirtyPromptForId !== loadedId) {
			const previousId = loadedId;
			if (!confirm('Discard your unsaved changes to this file?')) {
				onFileRestore?.(previousId);
				return;
			}
		}

		skipDirtyPromptForId = null;
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

	// three.js is far too big to sit in the bundle every file list pulls in, so the CAD
	// viewer is fetched the first time a mesh is opened and then kept — the same shape as
	// the highlighter's dynamic import above. `cadFailed` distinguishes "still downloading"
	// from "the chunk isn't coming", which for an offline user is the difference between a
	// spinner that resolves and one that doesn't.
	let CadViewer = $state<typeof import('./CadViewer.svelte').default | null>(null);
	let cadFailed = $state(false);

	$effect(() => {
		if (kind !== 'model' || CadViewer || cadFailed) return;

		import('./CadViewer.svelte')
			.then((module) => {
				CadViewer = module.default;
			})
			.catch(() => {
				cadFailed = true;
			});
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

		const { downloadUrl } = await res.json() as { downloadUrl: string };
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
		resizing = false;
		resizeClosePending = false;
		document.body.style.userSelect = '';
		onClose();
	}

	function requestTabClose(tabId: string) {
		if (tabId === file?.id && dirty) {
			if (!confirm('Discard your unsaved changes?')) return;
			skipDirtyPromptForId = tabId;
		}
		onTabClose(tabId);
	}

	function resizeTo(px: number) {
		if (px <= CLOSE_WIDTH) {
			if (resizeClosePending) return;
			resizeClosePending = true;
			requestClose();
			return;
		}

		resizeClosePending = false;
		width = clampWidth(px);
	}

	function startResize(e: PointerEvent) {
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		resizing = true;
		resizeClosePending = false;
		document.body.style.userSelect = 'none';
	}

	function moveResize(e: PointerEvent) {
		if (!resizing) return;
		resizeTo(window.innerWidth - e.clientX);
	}

	function endResize(e: PointerEvent) {
		if (!resizing) return;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		resizing = false;
		resizeClosePending = false;
		document.body.style.userSelect = '';
	}

	function resizeKeys(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		resizeTo((width ?? defaultWidth()) + (e.key === 'ArrowLeft' ? 24 : -24));
	}

	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (!dirty) return;
		e.preventDefault();
	}

	// A width dragged out on a wide window would overhang a narrower one.
	function onWindowResize() {
		if (width !== null) width = clampWidth(width);
	}

	// Bound by hand rather than through <svelte:window>, which only unbinds when Svelte
	// destroys the component — and Astro's ClientRouter discards an island's DOM without
	// ever destroying it. A leaked onbeforeunload is the one that shows: it would keep
	// warning about a buffer whose editor is long gone. See lib/island-teardown.ts.
	onMount(() => {
		window.addEventListener('resize', onWindowResize);
		window.addEventListener('beforeunload', onBeforeUnload);
		return onSwapOrDestroy(() => {
			requestSeq += 1;
			contentRequest?.abort();
			contentRequest = null;
			window.removeEventListener('resize', onWindowResize);
			window.removeEventListener('beforeunload', onBeforeUnload);
		}, '[data-global-file-viewer]');
	});
</script>

<!-- The highlighter's token tree, rendered as ordinary markup. Text goes through Svelte's
     own interpolation, so the file's contents are escaped by the framework and nothing here
     needs {@html} or a sanitizer beside it. Deliberately written on one line: this renders
     inside a <pre>, where any newline or indentation between these tags would become a real
     text node and corrupt the code's own whitespace. -->
{#snippet syntax(nodes: RootContent[])}{#each nodes as node}{#if node.type === 'text'}{node.value}{:else if node.type === 'element'}<span class={tokenClass(node)}>{@render syntax(node.children)}</span>{/if}{/each}{/snippet}

{#if file}
	{@const parts = splitFilename(file.filename)}
	<aside
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
				{parts.base}{#if parts.ext}<span class="viewer-ext muted">{parts.ext}</span>{/if}{#if dirty}<span class="dirty-dot" title="Unsaved changes">•</span>{/if}
			</span>

			<div class="viewer-actions">
				{#if editing}
					<button type="button" class="btn-plain" onclick={save} disabled={saving || !dirty}>
						{saving ? 'Saving…' : 'Save'}
					</button>
					<button type="button" class="btn-plain" onclick={cancelEditing} disabled={saving}>Cancel</button>
				{:else}
					{#if isTextKind(kind)}
						<!-- Binary previews are view-only, and a permanently disabled Edit button reading
						     "you need edit access" would blame the wrong thing. -->
						<button
							type="button"
							class="btn-plain"
							onclick={startEditing}
							disabled={!canEdit || content === null}
							title={canEdit ? 'Edit this file' : 'You need edit access to this project'}
						>
							Edit
						</button>
					{/if}
					<button type="button" class="btn-plain" onclick={download} disabled={downloading}>
						{downloading ? 'Preparing…' : 'Download'}
					</button>
				{/if}
				<button type="button" class="btn-plain close-btn" aria-label="Close preview" onclick={requestClose}>✕</button>
			</div>
		</header>

		<nav class="viewer-tabs" aria-label="Open files">
			{#each tabs as tab (tab.id)}
				{@const tabParts = splitFilename(tab.filename)}
				<div class="viewer-tab" class:active={file?.id === tab.id}>
					<button
						type="button"
						class="viewer-tab-select"
						class:active={file?.id === tab.id}
						aria-current={file?.id === tab.id ? 'page' : undefined}
						title={`Open ${tab.filename}`}
						onclick={() => onTabSelect(tab.id)}
					>
						<span class="viewer-tab-name">{tabParts.base}</span>
						{#if tabParts.ext}<span class="viewer-tab-ext muted">{tabParts.ext}</span>{/if}
						{#if file?.id === tab.id && dirty}<span class="viewer-tab-dirty" title="Unsaved changes">•</span>{/if}
					</button>
					<button
						type="button"
						class="viewer-tab-close"
						aria-label={`Close ${tab.filename}`}
						title={`Close ${tab.filename}`}
						onclick={() => requestTabClose(tab.id)}
					>
						×
					</button>
				</div>
			{/each}
		</nav>

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

		<div class="viewer-body" class:editing class:model={kind === 'model'} class:pdf={kind === 'pdf'}>
			{#if kind === 'unsupported'}
				<p class="viewer-note">Unsupported</p>
				<p class="viewer-note muted">This file can't be previewed. Download it to open it locally.</p>
			{:else if kind === 'model'}
				{#if CadViewer}
					<!-- Deliberately not keyed on the file id: opening a second mesh re-points
					     this instance instead of remounting it, so the panel doesn't burn one of
					     the browser's ~16 WebGL contexts per file clicked. The viewer clears its
					     own scene the moment a new id arrives. -->
					<CadViewer fileId={file.id} filename={file.filename} />
				{:else if cadFailed}
					<p class="viewer-note error">Could not load the 3D viewer. Download the file to open it locally.</p>
				{:else}
					<p class="viewer-note muted">Loading 3D viewer…</p>
				{/if}
			{:else if kind === 'pdf'}
				<iframe
					class="pdf-frame"
					src={`/api/files/${file.id}/raw`}
					title={`PDF preview of ${file.filename}`}
				></iframe>
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
					{...{ autocorrect: 'off' }}
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
		top: var(--space-4);
		right: var(--space-4);
		bottom: var(--space-4);
		/* z-index comes in inline, from the zIndex prop. */
		display: flex;
		flex-direction: column;
		max-width: 100vw;
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: 0 12px 32px rgb(0 0 0 / 14%);
		overflow: hidden;
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
		background: var(--color-highlight-strong);
		outline: none;
	}

	.viewer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface-raised);
	}

	.viewer-name {
		font-size: 0.85rem;
		font-weight: 700;
		/* min-width:0 — a flex item won't shrink below its content without it, and the
		   ellipsis never kicks in. */
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.viewer-ext {
		margin-left: 2px;
		font-size: 0.78rem;
		font-weight: 400;
	}

	.download-error,
	.save-error {
		margin: 0;
		padding: var(--space-2) var(--space-4);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface-inset);
		color: var(--color-danger);
		font-size: 0.8rem;
	}

	.viewer-actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: 0 0 auto;
	}

	.viewer-actions button {
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
		line-height: 1.4;
	}

	.viewer-actions .close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border-color: transparent;
		color: var(--color-muted);
		font-size: 1rem;
		line-height: 1;
	}

	.viewer-actions .close-btn:hover {
		background: var(--color-highlight);
		border-color: var(--color-border);
		color: var(--color-fg);
		opacity: 1;
	}

	.viewer-tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		flex: 0 0 auto;
		min-width: 0;
		overflow-x: auto;
		padding: 0 var(--space-3);
		background: var(--color-surface-inset);
		border-bottom: 1px solid var(--color-border);
		scrollbar-width: thin;
	}

	.viewer-tab {
		display: flex;
		align-items: stretch;
		min-width: 0;
		max-width: 200px;
		border-radius: var(--radius-sm) var(--radius-sm) 0 0;
	}

	.viewer-tab.active {
		background: var(--color-surface-raised);
		box-shadow: inset 0 -2px 0 var(--color-border-strong);
	}

	.viewer-tab-select,
	.viewer-tab-close {
		border: none;
		background: transparent;
		color: var(--color-muted);
		cursor: pointer;
	}

	.viewer-tab-select {
		display: flex;
		align-items: baseline;
		gap: 2px;
		min-width: 0;
		max-width: 176px;
		padding: var(--space-2) var(--space-1) var(--space-2) var(--space-2);
		text-align: left;
	}

	.viewer-tab-select:hover,
	.viewer-tab-close:hover {
		background: var(--color-highlight);
		color: var(--color-fg);
		opacity: 1;
	}

	.viewer-tab-select.active {
		color: var(--color-fg);
	}

	.viewer-tab-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.viewer-tab-ext {
		flex: 0 0 auto;
		font-size: 0.72rem;
	}

	.viewer-tab-dirty {
		flex: 0 0 auto;
		color: var(--color-danger);
		line-height: 1;
	}

	.viewer-tab-close {
		flex: 0 0 auto;
		width: 24px;
		padding: 0;
		font-size: 0.95rem;
		line-height: 1;
	}

	.viewer-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: var(--space-4);
		background: var(--color-surface-inset);
	}

	/* The textarea sizes itself to the body, so the body must not scroll on its own —
	   the scrollbar belongs to the editor. Same for the CAD canvas, which is sized in JS
	   from the box this gives it: let the body scroll and the two would chase each other
	   bigger on every resize. */
	.viewer-body.editing,
	.viewer-body.model,
	.viewer-body.pdf {
		display: flex;
		overflow: hidden;
	}

	.viewer-body.pdf {
		padding: 0;
	}

	.pdf-frame {
		flex: 1;
		min-width: 0;
		border: 0;
		background: var(--color-surface-raised);
	}

	/* The viewer fills the body, and its own flex column puts the readout bar at the
	   bottom. */
	.viewer-body.model > :global(.cad) {
		flex: 1;
		min-width: 0;
	}

	.editor {
		flex: 1;
		min-height: 0;
		width: 100%;
		box-sizing: border-box;
		resize: none;
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		background: var(--color-surface-raised);
		font-family: var(--font-mono);
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
		max-width: 34rem;
		font-size: 0.85rem;
	}

	.viewer-note.error {
		color: var(--color-danger);
	}

	.text-body {
		margin: 0;
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-raised);
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
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-raised);
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
			top: 0;
			right: 0;
			bottom: 0;
			width: 100vw !important;
			border: none;
			border-radius: 0;
			box-shadow: none;
		}

		.resize-handle {
			display: none;
		}

		.viewer-head {
			padding: var(--space-3) var(--space-4);
		}

		.viewer-body {
			padding: var(--space-3);
		}

		.viewer-body.pdf {
			padding: 0;
		}
	}
</style>
