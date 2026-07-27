<script lang="ts">
	import { onMount } from 'svelte';
	import FileViewerPanel from './FileViewerPanel.svelte';
	import { splitFilename } from '../lib/file-kind';
	import { formatFileSize } from '../lib/format-bytes';
	import { adjustStorageUsage } from '../lib/storage-usage.svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';

	interface MyFile {
		id: string;
		filename: string;
		size_bytes: number | null;
		project_id: string;
		projects: { name: string } | null;
	}

	let open = $state(false);
	let viewMode = $state<'list' | 'grid'>('grid');
	let files = $state<MyFile[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);
	let viewingFile = $state<MyFile | null>(null);
	// Reported by the panel. The modal centres itself in what's left of the viewport, so
	// opening (or dragging) a preview slides it clear instead of hiding under it.
	let panelWidth = $state(0);
	// Also reported by the panel: true while its editor holds unsaved changes. The modal
	// closes the panel by unmounting it, so every close path here has to ask first.
	let previewDirty = $state(false);

	// One group per project, biggest project first, biggest file first inside it. The
	// endpoint already orders by size, but grouping has to happen somewhere and doing
	// it here keeps the order right after a delete or an edit changes a size.
	const groups = $derived.by(() => {
		const byProject = new Map<string, { projectId: string; name: string; files: MyFile[]; totalBytes: number }>();

		for (const file of files) {
			let group = byProject.get(file.project_id);
			if (!group) {
				group = { projectId: file.project_id, name: file.projects?.name ?? 'Untitled project', files: [], totalBytes: 0 };
				byProject.set(file.project_id, group);
			}
			group.files.push(file);
			group.totalBytes += file.size_bytes ?? 0;
		}

		const list = [...byProject.values()];
		for (const group of list) group.files.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
		list.sort((a, b) => b.totalBytes - a.totalBytes);
		return list;
	});

	async function openModal() {
		open = true;

		const stored = localStorage.getItem('p2-file-view-mode');
		if (stored === 'grid' || stored === 'list') viewMode = stored;

		loading = true;
		loadError = null;

		const res = await fetch('/api/files/mine');

		if (!res.ok) {
			loadError = await res.text();
			loading = false;
			return;
		}

		files = await res.json();
		loading = false;
	}

	function closeModal() {
		if (previewDirty && !confirm('Discard your unsaved changes to the open file?')) return;

		open = false;
		// The panel is fixed to the viewport, so it would outlive the modal it was opened from.
		viewingFile = null;
	}

	function handleFileSaved(fileId: string, sizeBytes: number) {
		const saved = files.find((f) => f.id === fileId);
		if (!saved) return;

		// Every file listed here is one this user uploaded, so the whole delta lands on
		// their own usage figure.
		adjustStorageUsage(sizeBytes - (saved.size_bytes ?? 0));
		files = files.map((f) => (f.id === fileId ? { ...f, size_bytes: sizeBytes } : f));
	}

	async function handleDelete(fileId: string) {
		if (!confirm('Delete this file? This cannot be undone.')) return;

		rowError = null;
		deletingId = fileId;

		const res = await fetch(`/api/files/${fileId}/delete`, { method: 'POST' });

		if (!res.ok) {
			rowError = { id: fileId, message: await res.text() };
			deletingId = null;
			return;
		}

		const deletedFile = files.find((f) => f.id === fileId);
		files = files.filter((f) => f.id !== fileId);
		// The preview would keep showing a file that no longer exists.
		if (viewingFile?.id === fileId) viewingFile = null;
		if (deletedFile?.size_bytes) adjustStorageUsage(-deletedFile.size_bytes);
		deletingId = null;
	}

	onMount(() => {
		// Escape peels off one layer at a time, so it can't close the modal out from under
		// an open preview. The panel's own Escape handling is off for the same reason.
		function onKeydown(e: KeyboardEvent) {
			if (!open || e.key !== 'Escape') return;
			// An open editor with unsaved changes swallows Escape entirely, exactly as it
			// does in the panel itself — the buffer leaves through Save or Cancel only.
			if (previewDirty) return;
			if (viewingFile) viewingFile = null;
			else closeModal();
		}
		window.addEventListener('keydown', onKeydown);
		return onSwapOrDestroy(() => window.removeEventListener('keydown', onKeydown));
	});
</script>

<button type="button" class="open-link" onclick={openModal} aria-label="View your uploaded files">↗</button>

{#if open}
	<div
		class="modal-backdrop"
		style={`padding-right: calc(var(--space-4) + ${panelWidth}px)`}
		onclick={closeModal}
	>
		<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Your files</h3>
				<button type="button" class="btn-plain" onclick={closeModal}>Close</button>
			</div>

			{#if loading}
				<p class="muted">Loading…</p>
			{:else if loadError}
				<p class="row-error">{loadError}</p>
			{:else if files.length === 0}
				<p class="muted">You haven't uploaded any files yet.</p>
			{:else}
				{#each groups as group (group.projectId)}
					<section class="file-group">
						<div class="group-head">
							<span class="group-name">{group.name}</span>
							<span class="muted group-meta">
								{group.files.length} file{group.files.length === 1 ? '' : 's'} — {formatFileSize(group.totalBytes)}
							</span>
						</div>
						<ul class={viewMode === 'grid' ? 'grid-view' : 'file-list'}>
							{#each group.files as file (file.id)}
								{@const parts = splitFilename(file.filename)}
								{#if viewMode === 'grid'}
									<li class="grid-item" class:open={viewingFile?.id === file.id}>
										<button type="button" class="grid-download" onclick={() => (viewingFile = file)}>
											<span class="grid-icon">📄</span>
											<span class="grid-name">{parts.base}</span>
											{#if parts.ext}<span class="grid-ext muted">{parts.ext}</span>{/if}
										</button>
										<span class="grid-size muted">
											{file.size_bytes != null ? formatFileSize(file.size_bytes) : ''}
										</span>
										<button
											type="button"
											class="trash-btn"
											aria-label="Delete file"
											onclick={() => handleDelete(file.id)}
											disabled={deletingId === file.id}
										>
											🗑
										</button>
										{#if rowError?.id === file.id}<p class="row-error">{rowError.message}</p>{/if}
									</li>
								{:else}
									<li class="file-row" class:open={viewingFile?.id === file.id}>
										<button type="button" class="btn-plain file-download" onclick={() => (viewingFile = file)}>
											<span class="file-name">{parts.base}</span>
											{#if parts.ext}<span class="file-ext muted">{parts.ext}</span>{/if}
										</button>
										<span class="muted file-meta">
											{file.size_bytes != null ? formatFileSize(file.size_bytes) : ''}
										</span>
										<button
											type="button"
											class="trash-btn"
											aria-label="Delete file"
											onclick={() => handleDelete(file.id)}
											disabled={deletingId === file.id}
										>
											🗑
										</button>
										{#if rowError?.id === file.id}<p class="row-error">{rowError.message}</p>{/if}
									</li>
								{/if}
							{/each}
						</ul>
					</section>
				{/each}
			{/if}
		</div>
	</div>
{/if}

<!-- Outside .modal-backdrop on purpose: a click anywhere inside it closes the modal, and
     the panel is a place people click. That puts it in the page's stacking context instead
     of the backdrop's, so it needs a z-index above the backdrop's own. -->
<FileViewerPanel
	file={viewingFile}
	zIndex={110}
	closeOnEscape={false}
	onWidthChange={(w) => (panelWidth = w)}
	onDirtyChange={(d) => (previewDirty = d)}
	onSaved={handleFileSaved}
	onFileRestore={(fileId) => {
		const previous = files.find((f) => f.id === fileId);
		if (previous) viewingFile = previous;
	}}
	onClose={() => (viewingFile = null)}
/>

<style>
	.open-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--color-muted);
		cursor: pointer;
	}

	.open-link:hover {
		color: var(--color-fg);
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 100;
	}

	.modal-box {
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-5);
		width: 100%;
		max-width: 680px;
		/* Lets the box shrink past its content once a wide preview panel eats into the
		   space beside it — a flex item won't go below min-content otherwise. */
		min-width: 0;
		max-height: 70vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.modal-header h3 {
		margin: 0;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}

	.trash-btn {
		background: none;
		border: none;
		padding: 0 var(--space-1);
		color: var(--color-muted);
		font-size: 1rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.trash-btn:hover {
		color: var(--color-danger);
	}

	/* Project groups */

	/* On top of .modal-box's own gap — a group's files sit directly under the previous
	   group's last row otherwise, with only the heading rule to separate them. */
	.file-group + .file-group {
		margin-top: var(--space-2);
	}

	.group-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-2);
		border-bottom: 1px solid var(--color-border-strong);
		padding-bottom: var(--space-1);
		margin-bottom: var(--space-2);
	}

	.group-name {
		font-size: 0.8rem;
		/* The project name is user text — it can be long, and the count/total beside it
		   is the part that must stay readable. */
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.group-meta {
		font-size: 0.75rem;
		white-space: nowrap;
	}

	/* List view */

	.file-list {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.85rem;
	}

	.file-list > .file-row {
		padding: var(--space-2) 0;
		border-top: 1px solid var(--color-border);
	}

	.file-list > .file-row:first-child {
		border-top: none;
	}

	.file-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	/* The file whose preview panel is open. The negative margin cancels the padding so
	   the band widens without the row's text shifting sideways as it opens. */
	.file-list > .file-row.open {
		background: var(--color-highlight);
		box-shadow: inset 2px 0 0 var(--color-border-strong);
		padding-left: var(--space-2);
		padding-right: var(--space-2);
		margin-left: calc(-1 * var(--space-2));
		margin-right: calc(-1 * var(--space-2));
	}

	.file-download {
		display: flex;
		align-items: baseline;
		gap: var(--space-1);
	}

	.file-meta {
		font-size: 0.8rem;
		flex: 1 1 auto;
	}

	/* Grid view */

	.grid-view {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: var(--space-3);
	}

	.grid-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		border: 1px solid var(--color-border);
		padding: var(--space-3) var(--space-2);
		text-align: center;
	}

	.grid-item.open {
		border-color: var(--color-border-strong);
		background: var(--color-highlight);
	}

	.grid-download {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-fg);
		cursor: pointer;
	}

	.grid-icon {
		font-size: 1.5rem;
		line-height: 1;
	}

	.grid-name {
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 0.8rem;
	}

	.grid-ext {
		font-size: 0.7rem;
	}

	.grid-size {
		font-size: 0.7rem;
	}
</style>
