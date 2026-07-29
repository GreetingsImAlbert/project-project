<script lang="ts">
	import { slide } from 'svelte/transition';
	import FolderPickerModal from './FolderPickerModal.svelte';
	import { splitFilename } from '../lib/file-kind';

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		uploaded_by: string | null;
		uploader_deleted_at?: string | null;
		profiles: { display_name: string } | null;
		is_journal?: boolean;
	}

	// Mirrors FILE_GRACE_DAYS in src/lib/account-deletion.ts — kept as a plain number
	// here rather than imported, since that module also pulls in aws4fetch/service-role
	// Supabase types that have no business in a client bundle.
	const FILE_GRACE_DAYS = 30;

	function purgeWarning(file: FileRow): string | null {
		if (!file.uploader_deleted_at) return null;
		const daysLeft = Math.max(
			0,
			FILE_GRACE_DAYS - Math.floor((Date.now() - new Date(file.uploader_deleted_at).getTime()) / (24 * 60 * 60 * 1000)),
		);
		return `Uploaded by a deleted account — removed in ${daysLeft} day${daysLeft === 1 ? '' : 's'} unless someone copies it first`;
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
		{#if !file.is_journal}
			<button type="button" class="btn-danger" onclick={() => handleDelete(file.id)} disabled={deletingId === file.id}>
				{deletingId === file.id ? 'Deleting…' : 'Delete'}
			</button>
		{/if}
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
					<span class="grid-name">
						<span class="grid-name-text">{parts.base}</span>
						{#if purgeWarning(file)}<span class="purge-warning-icon" data-tooltip={purgeWarning(file)}>⚠</span>{/if}
					</span>
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
				<div class="file-header" class:with-actions={canEdit}>
					<div class="cell cell-name">
						<button
							type="button"
							class="btn-plain file-name-btn"
							title={file.filename}
							onclick={() => onFileOpen(file)}
						>
							<span class="file-icon">📄</span>
							<span class="file-name-text">{parts.base}</span>
							{#if parts.ext}<span class="file-ext muted">{parts.ext}</span>{/if}
						</button>
						{#if purgeWarning(file)}<span class="purge-warning-icon" data-tooltip={purgeWarning(file)}>⚠</span>{/if}
					</div>

					<div class="cell cell-meta muted">
						{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B` : ''}
						— uploaded by {file.profiles?.display_name ?? 'a deleted account'}
					</div>

					{#if canEdit}
						<div class="cell cell-actions">
							<button type="button" class="btn-plain" onclick={() => openModal(file, 'move')}>Move</button>
							<button type="button" class="btn-plain" onclick={() => openModal(file, 'copy')}>Copy</button>
							{#if !file.is_journal}
								<button type="button" class="btn-danger" onclick={() => handleDelete(file.id)} disabled={deletingId === file.id}>
									{deletingId === file.id ? 'Deleting…' : 'Delete'}
								</button>
							{/if}
						</div>
					{/if}
				</div>

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
		font-size: 0.82rem;
	}

	.file-list > .file-row {
		border-top: 1px solid var(--color-border);
	}

	.file-list > .file-row:first-child {
		border-top: none;
	}

	.file-row {
		position: relative;
	}

	/* The file whose preview panel is open. The negative margin cancels the padding so
	   the band widens without the row's text shifting sideways as it opens. */
	.file-list > .file-row.open {
		background: var(--color-highlight);
		box-shadow: inset 2px 0 0 var(--color-border-strong);
	}

	/* One row, three columns: a fixed-width name (so every row's name box lines up the
	   same way TasksTable's cell-task column does), a flexible meta strip, and an
	   actions column that only exists when canEdit — mirrors task-row/.with-actions. */
	.file-header {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-1) var(--space-2);
	}

	.file-header.with-actions {
		grid-template-columns: 220px minmax(0, 1fr) auto;
	}

	.cell {
		min-width: 0;
	}

	.cell-name {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	/* A real button so the row opens from the keyboard too, styled back down to plain
	   text — same trick as TasksTable's .task-name. */
	.file-name-btn {
		display: flex;
		align-items: baseline;
		gap: 3px;
		min-width: 0;
		max-width: 100%;
		background: none;
		border: none;
		padding: 0;
		margin: 0;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.file-name-btn:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.file-icon {
		flex: 0 0 auto;
	}

	.file-name-text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.file-ext {
		flex: 0 0 auto;
		font-size: 0.76rem;
	}

	.cell-meta {
		font-size: 0.78rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.cell-actions {
		display: flex;
		gap: var(--space-1);
		justify-content: flex-end;
	}

	.cell-actions button {
		flex-shrink: 0;
		white-space: nowrap;
		padding: 0 var(--space-2);
		font-size: 0.7rem;
		line-height: 1.8;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
		padding: 0 var(--space-2) var(--space-2);
	}

	@media (max-width: 640px) {
		.file-header,
		.file-header.with-actions {
			grid-template-columns: minmax(0, 1fr) auto;
			row-gap: var(--space-1);
		}

		.cell-meta {
			grid-column: 1 / -1;
			white-space: normal;
		}

		.cell-actions {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}
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

	/* Grid items paint in DOM order with no z-index of their own, so the tooltip
	   below overflows past this cell's box and the next cell (painted after it)
	   covers it. An explicit z-index only while hovered lifts this cell above its
	   unhovered siblings without disturbing paint order the rest of the time. */
	.grid-item:hover {
		z-index: 1;
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
		display: flex;
		align-items: center;
		gap: 3px;
		max-width: 100%;
		font-size: 0.8rem;
	}

	/* Only the text itself truncates — the warning icon sits outside this span so
	   its hover tooltip (an absolutely positioned ::after) isn't clipped by the
	   overflow:hidden that makes the ellipsis work. */
	.grid-name-text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.grid-ext {
		font-size: 0.7rem;
	}

	.purge-warning-icon {
		position: relative;
		flex: 0 0 auto;
		color: var(--color-danger);
		cursor: help;
	}

	.purge-warning-icon::after {
		content: attr(data-tooltip);
		position: absolute;
		bottom: 100%;
		left: 50%;
		transform: translateX(-50%);
		margin-bottom: var(--space-1);
		width: max-content;
		max-width: 180px;
		background: var(--color-fg);
		color: var(--color-bg);
		padding: var(--space-1) var(--space-2);
		font-size: 0.7rem;
		font-weight: normal;
		line-height: 1.3;
		white-space: normal;
		text-align: left;
		border-radius: 3px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.1s;
		z-index: 20;
	}

	.purge-warning-icon:hover::after {
		opacity: 1;
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
</style>
