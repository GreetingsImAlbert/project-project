<script lang="ts">
	import { slide } from 'svelte/transition';
	import FolderPickerModal from './FolderPickerModal.svelte';
	import { splitFilename } from '../lib/file-kind';

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		uploaded_by: string;
		profiles: { display_name: string } | null;
	}

	interface Folder {
		id: string;
		name: string;
		parent_folder_id: string | null;
	}

	let {
		canEdit,
		currentFolderId,
		allFolders,
		files,
		viewMode,
		loading = false,
		openFileId = null,
		onFileOpen,
		onFileMoved,
		onFileCopied,
		onFileDeleted,
	}: {
		canEdit: boolean;
		currentFolderId: string | null;
		allFolders: Folder[];
		files: FileRow[];
		viewMode: 'list' | 'grid';
		loading?: boolean;
		openFileId?: string | null;
		onFileOpen: (file: FileRow) => void;
		onFileMoved: (fileId: string, targetFolderId: string | null) => void;
		onFileCopied: (file: FileRow, targetFolderId: string | null) => void;
		onFileDeleted: (fileId: string) => void;
	} = $props();

	let deletingId = $state<string | null>(null);
	let openActionsId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let modalFile = $state<{ file: FileRow; mode: 'move' | 'copy' } | null>(null);
	let modalBusy = $state(false);
	let modalError = $state<string | null>(null);

	function toggleActions(fileId: string) {
		openActionsId = openActionsId === fileId ? null : fileId;
	}

	function handleWindowClick(e: MouseEvent) {
		if (openActionsId === null) return;

		// The whole composed path, not just e.target: a button inside the popover can already
		// be detached by the time the click reaches the window (Delete swaps to 'Deleting…',
		// Move/Copy close the popover outright), and a detached node has no ancestors left to
		// match against. The path is fixed when the event is dispatched, so it still names the
		// popover. The marker is on the toggle too — otherwise the click that opens the popover
		// would immediately close it again. Folder popovers use their own marker so clicking
		// one closes the other.
		const insideActions = e
			.composedPath()
			.some((node) => node instanceof Element && node.hasAttribute('data-file-actions'));

		if (!insideActions) openActionsId = null;
	}

	function openModal(file: FileRow, mode: 'move' | 'copy') {
		modalFile = { file, mode };
		modalError = null;
		openActionsId = null;
	}

	function closeModal() {
		modalFile = null;
		modalError = null;
	}

	async function confirmModal(targetFolderId: string | null) {
		if (!modalFile) return;
		const { file, mode } = modalFile;

		modalBusy = true;
		modalError = null;

		const res = await fetch(`/api/files/${file.id}/${mode}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ folderId: targetFolderId }),
		});

		if (!res.ok) {
			modalError = await res.text();
			modalBusy = false;
			return;
		}

		if (mode === 'move') {
			onFileMoved(file.id, targetFolderId);
		} else {
			const copied: FileRow = await res.json();
			onFileCopied(copied, targetFolderId);
		}

		modalBusy = false;
		modalFile = null;
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

		onFileDeleted(fileId);
		deletingId = null;
		openActionsId = null;
	}
</script>

{#snippet actionsPanel(file: FileRow)}
	<div class="actions-panel" data-file-actions transition:slide={{ duration: 150 }}>
		<button type="button" class="btn-plain" onclick={() => openModal(file, 'move')}>Move</button>
		<button type="button" class="btn-plain" onclick={() => openModal(file, 'copy')}>Copy</button>
		<button type="button" class="btn-danger" onclick={() => handleDelete(file.id)} disabled={deletingId === file.id}>
			{deletingId === file.id ? 'Deleting…' : 'Delete'}
		</button>
	</div>
{/snippet}

<svelte:window onclick={handleWindowClick} />

{#if !loading && files.length === 0}
	<p class="muted">No files here.</p>
{/if}

<ul class={viewMode === 'grid' ? 'grid-view' : 'file-list'}>
	{#each files as file (file.id)}
		{@const parts = splitFilename(file.filename)}
		{#if viewMode === 'grid'}
			<li class="grid-item" class:open={openFileId === file.id}>
				<button type="button" class="grid-download" onclick={() => onFileOpen(file)}>
					<span class="grid-icon">📄</span>
					<span class="grid-name">{parts.base}</span>
					{#if parts.ext}<span class="grid-ext muted">{parts.ext}</span>{/if}
				</button>

				{#if canEdit}
					<button type="button" class="grid-actions-toggle" data-file-actions aria-label="Actions" onclick={() => toggleActions(file.id)}>
						{openActionsId === file.id ? '▴' : '▾'}
					</button>
				{/if}

				{#if canEdit && openActionsId === file.id}
					{@render actionsPanel(file)}
				{/if}

				{#if rowError?.id === file.id}
					<p class="row-error">{rowError.message}</p>
				{/if}
			</li>
		{:else}
			<li class="file-row" class:open={openFileId === file.id}>
				<div class="file-header">
					<div class="file-main">
						<div class="file-name">
							<button type="button" class="btn-plain" onclick={() => onFileOpen(file)}>{parts.base}</button>
							{#if parts.ext}<span class="file-ext muted">{parts.ext}</span>{/if}
						</div>
						<span class="muted file-meta">
							{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B` : ''}
							— uploaded by {file.profiles?.display_name}
						</span>
					</div>

					{#if canEdit}
						<button type="button" class="btn-plain actions-toggle" data-file-actions onclick={() => toggleActions(file.id)}>
							Actions {openActionsId === file.id ? '▴' : '▾'}
						</button>
					{/if}
				</div>

				{#if canEdit && openActionsId === file.id}
					{@render actionsPanel(file)}
				{/if}

				{#if rowError?.id === file.id}
					<p class="row-error">{rowError.message}</p>
				{/if}
			</li>
		{/if}
	{/each}
</ul>

{#if modalFile}
	<FolderPickerModal
		allFolders={allFolders}
		initialFolderId={currentFolderId}
		actionLabel={modalFile.mode === 'move' ? 'Move here' : 'Copy here'}
		viewMode={viewMode}
		busy={modalBusy}
		error={modalError}
		onConfirm={confirmModal}
		onCancel={closeModal}
	/>
{/if}

<style>
	.file-list {
		list-style: none;
		margin: 0 0 var(--space-4);
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
		position: relative;
		display: flex;
		flex-direction: column;
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

	.file-header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
	}

	.file-main {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.file-name {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.file-ext {
		font-size: 0.75rem;
	}

	.file-meta {
		font-size: 0.8rem;
	}

	.actions-panel {
		position: absolute;
		top: calc(100% + var(--space-1));
		left: 0;
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-2);
	}

	.actions-panel button {
		width: 100%;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}

	/* Grid view */

	.grid-view {
		list-style: none;
		margin: 0 0 var(--space-4);
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: var(--space-3);
	}

	.grid-item {
		position: relative;
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

	.grid-actions-toggle {
		background: none;
		border: none;
		padding: 0 var(--space-2);
		color: var(--color-muted);
		font-size: 0.9rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.grid-actions-toggle:hover {
		color: var(--color-fg);
	}
</style>
