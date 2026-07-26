<script lang="ts">
	import { fly } from 'svelte/transition';
	import { fileKind, splitFilename } from '../lib/file-kind';
	import { renderMarkdown } from '../lib/markdown';

	interface ViewerFile {
		id: string;
		filename: string;
	}

	let {
		file,
		onClose,
		zIndex = 50,
		closeOnEscape = true,
		onWidthChange,
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
		// How much of the right edge the panel is covering right now (0 when closed), so a
		// host that overlays content of its own can keep it clear of the panel. Fires on
		// open, on close, and continuously while the handle is dragged.
		onWidthChange?: (width: number) => void;
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

	let kind = $derived(file ? fileKind(file.filename) : 'unsupported');
	let html = $derived(kind === 'markdown' && content !== null ? renderMarkdown(content) : '');

	// Bumped per open so a slow response for a file the user already navigated away
	// from can't paint itself into the panel.
	let requestSeq = 0;
	let loadedId: string | null = null;

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

	$effect(() => {
		const current = file;

		if (!current) {
			loadedId = null;
			return;
		}

		if (!sized) {
			sized = true;
			width = defaultWidth();
		}

		if (current.id === loadedId) return;

		loadedId = current.id;
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
					const data = (await res.json()) as { content: string };
					content = data.content;
				}
				loading = false;
			})
			.catch(() => {
				if (seq !== requestSeq) return;
				error = 'Could not load this file';
				loading = false;
			});
	});

	$effect(() => {
		onWidthChange?.(file && width !== null ? width : 0);
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
		if (e.key === 'Escape' && file && closeOnEscape) onClose();
	}

	// Where the press that produced the click started, and what was open at the time.
	// Both are read by onWindowClick below; see the reasoning there.
	let pressOrigin: EventTarget | null = null;
	let fileAtPress: ViewerFile | null = null;

	function onWindowPointerDown(e: PointerEvent) {
		pressOrigin = e.target;
		fileAtPress = file;
	}

	function onWindowClick(e: MouseEvent) {
		// Both press values are consumed here, not just read: a keyboard-activated click has
		// no pointerdown of its own, and stale values from the last real press would make it
		// look like a click on some other element, on some other file.
		const origin = pressOrigin ?? e.target;
		const openAtPress = fileAtPress;
		pressOrigin = null;
		fileAtPress = null;

		if (!file) return;

		// The click that opened this file arrives here too — it bubbles to the window after
		// the list's own handler has already swapped `file` — and closing on it would make
		// files in the list un-openable.
		if (file.id !== openAtPress?.id) return;

		// The press's origin, not the click's target: a resize drag that starts on the handle
		// and ends out over the page reads as a click on their common ancestor, and selecting
		// text in the panel can end anywhere at all.
		if (origin instanceof Node && panelEl?.contains(origin)) return;

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
/>

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
				{parts.base}{#if parts.ext}<span class="muted">{parts.ext}</span>{/if}
			</span>

			<div class="viewer-actions">
				<button type="button" class="btn-plain" disabled title="Editing isn't available yet">Edit</button>
				<button type="button" class="btn-plain" onclick={download} disabled={downloading}>
					{downloading ? 'Preparing…' : 'Download'}
				</button>
				<button type="button" class="btn-plain close-btn" aria-label="Close preview" onclick={onClose}>✕</button>
			</div>
		</header>

		{#if downloadError}
			<p class="download-error">{downloadError}</p>
		{/if}

		<div class="viewer-body">
			{#if kind === 'unsupported'}
				<p class="viewer-note">Unsupported</p>
				<p class="viewer-note muted">This file can't be previewed. Download it to open it locally.</p>
			{:else if loading}
				<p class="viewer-note muted">Loading…</p>
			{:else if error}
				<p class="viewer-note error">{error}</p>
			{:else if content !== null}
				{#if kind === 'markdown'}
					<!-- renderMarkdown escapes the whole source and only emits tags it built
					     itself, so an uploaded .md can't inject markup here. -->
					<div class="md-body">{@html html}</div>
				{:else}
					<pre class="text-body">{content}</pre>
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

	.download-error {
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
