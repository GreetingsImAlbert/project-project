<script lang="ts">
	import { slide } from 'svelte/transition';
	import FolderPickerModal from './FolderPickerModal.svelte';
	import RenameModal from './RenameModal.svelte';
	import { splitFilename } from '../lib/file-kind';
	import { onSwapOrDestroy } from '../lib/island-teardown';

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		// Optional: the flat outsider list omits uploader identity entirely, so its
		// rows carry neither uploaded_by nor the embed that names it.
		uploaded_by?: string | null;
		uploader_deleted_at?: string | null;
		profiles?: { display_name: string } | null;
		is_journal?: boolean;
		is_public: boolean;
	}

	// Mirrors FILE_GRACE_DAYS in src/lib/account-deletion.ts — kept as a plain number
	// here rather than imported, since that module also pulls in aws4fetch/service-role
	// Supabase types that have no business in a client bundle.
	const FILE_GRACE_DAYS = 30;
	const FILE_PAGE_SIZE = 50;

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
		projectId,
		canEdit,
		readOnly = false,
		currentFolderId,
		allFolders,
		files,
		paginationKey,
		viewMode,
		loading = false,
		openFileId = null,
		onFileOpen,
		onFileMoved,
		onFileCopied,
		onFileDeleted,
		onFileRenamed,
		publicFilesEnabled,
		onFileVisibilityChanged,
	}: {
		projectId: string;
		canEdit: boolean;
		// Outsider mode: the flat public list — no uploader identity in the meta
		// column and no purge warnings that would hint at a deleted account.
		readOnly?: boolean;
		currentFolderId: string | null;
		allFolders: Folder[];
		files: FileRow[];
		paginationKey: string;
		viewMode: 'list' | 'grid';
		loading?: boolean;
		openFileId?: string | null;
		onFileOpen: (file: FileRow) => void;
		onFileMoved: (fileId: string, targetFolderId: string | null) => void;
		onFileCopied: (file: FileRow, targetFolderId: string | null) => void;
		onFileDeleted: (fileId: string) => void;
		onFileRenamed: (fileId: string, filename: string) => void;
		publicFilesEnabled: boolean;
		onFileVisibilityChanged: (fileId: string, isPublic: boolean) => void;
	} = $props();

	let deletingId = $state<string | null>(null);
	let openActionsId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let modalFile = $state<{ file: FileRow; mode: 'move' | 'copy' } | null>(null);
	let modalBusy = $state(false);
	let modalError = $state<string | null>(null);

	let renameTarget = $state<FileRow | null>(null);
	let renameBusy = $state(false);
	let renameError = $state<string | null>(null);
	let visibilitySavingId = $state<string | null>(null);
	let visibilitySavedId = $state<string | null>(null);
	let visibilityError = $state<{ id: string; message: string } | null>(null);
	let visibilitySavedTimer: ReturnType<typeof setTimeout> | undefined;
	let copiedLinkId = $state<string | null>(null);
	let copyLinkFailedId = $state<string | null>(null);
	let copyLinkTimer: ReturnType<typeof setTimeout> | undefined;
	let renderedFileCount = $state(FILE_PAGE_SIZE);
	let lastPaginationKey = $state<string | null>(null);

	$effect(() => {
		if (paginationKey === lastPaginationKey) return;
		lastPaginationKey = paginationKey;
		renderedFileCount = FILE_PAGE_SIZE;
		openActionsId = null;
		rowError = null;
	});

	let visibleFiles = $derived(files.slice(0, renderedFileCount));

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

	function openRename(file: FileRow) {
		renameTarget = file;
		renameError = null;
		openActionsId = null;
	}

	function closeRename() {
		renameTarget = null;
		renameError = null;
	}

	async function confirmRename(newFilename: string) {
		if (!renameTarget) return;
		const fileId = renameTarget.id;

		renameBusy = true;
		renameError = null;

		const res = await fetch(`/api/files/${fileId}/rename`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: newFilename }),
		});

		if (!res.ok) {
			renameError = await res.text();
			renameBusy = false;
			return;
		}

		onFileRenamed(fileId, newFilename);
		renameBusy = false;
		renameTarget = null;
	}

	// The shared link is the Files route with the viewer pointed at this file — the
	// same page outsiders land on, with no dedicated public file page. Only shown
	// while the file is effectively public (gate on, switch on), so it vanishes the
	// moment either one is turned off.
	async function copyPublicLink(file: FileRow) {
		const url = `/projects/${projectId}/files?file=${file.id}`;
		try {
			await navigator.clipboard.writeText(url);
			copyLinkFailedId = null;
			clearTimeout(copyLinkTimer);
			copiedLinkId = file.id;
			copyLinkTimer = setTimeout(() => {
				if (copiedLinkId === file.id) copiedLinkId = null;
			}, 2500);
		} catch {
			copiedLinkId = null;
			copyLinkFailedId = file.id;
		}
	}

	async function setFileVisibility(file: FileRow, isPublic: boolean) {
		if (!publicFilesEnabled || visibilitySavingId !== null || file.is_public === isPublic) return;

		visibilitySavingId = file.id;
		visibilitySavedId = null;
		visibilityError = null;

		try {
			const res = await fetch(`/api/files/${file.id}/visibility`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ isPublic }),
			});

			if (!res.ok) {
				visibilityError = { id: file.id, message: await res.text() };
				return;
			}

			onFileVisibilityChanged(file.id, isPublic);
			clearTimeout(visibilitySavedTimer);
			visibilitySavedId = file.id;
			visibilitySavedTimer = setTimeout(() => {
				if (visibilitySavedId === file.id) visibilitySavedId = null;
			}, 2500);
		} catch (cause) {
			visibilityError = {
				id: file.id,
				message: cause instanceof Error ? cause.message : 'Could not save file visibility',
			};
		} finally {
			visibilitySavingId = null;
		}
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

	function showMoreFiles() {
		renderedFileCount = Math.min(renderedFileCount + FILE_PAGE_SIZE, files.length);
	}

	onSwapOrDestroy(() => {
		clearTimeout(visibilitySavedTimer);
		clearTimeout(copyLinkTimer);
	});
</script>

{#snippet visibilityControl(file: FileRow)}
	<div class="file-visibility">
		<span class="visibility-label">Visibility</span>
		<button
			type="button"
			class="visibility-switch"
			class:active={file.is_public}
			role="switch"
			aria-checked={file.is_public}
			aria-label={`${file.filename} visibility`}
			disabled={!publicFilesEnabled || visibilitySavingId !== null}
			title={publicFilesEnabled ? (file.is_public ? 'Make this file private' : 'Make this file public') : 'Enable Files in Project Settings first'}
			onclick={() => setFileVisibility(file, !file.is_public)}
		>
			<span class="visibility-switch-track" aria-hidden="true">
				<span class="visibility-switch-thumb"></span>
			</span>
			<span class="visibility-switch-label">{file.is_public ? 'Public' : 'Private'}</span>
		</button>
		{#if visibilitySavingId === file.id}
			<span class="visibility-status muted" role="status">Saving…</span>
		{:else if visibilitySavedId === file.id}
			<span class="visibility-status muted" role="status">Saved</span>
		{/if}
		{#if visibilityError?.id === file.id}
			<span class="row-error">{visibilityError.message}</span>
		{/if}
	</div>
{/snippet}

{#snippet actionsPanel(file: FileRow)}
	<div class="actions-panel" data-file-actions transition:slide={{ duration: 150 }}>
		{@render visibilityControl(file)}
		{#if publicFilesEnabled && file.is_public}
			<button type="button" class="btn-plain" onclick={() => copyPublicLink(file)}>
				{copiedLinkId === file.id ? 'Copied' : copyLinkFailedId === file.id ? 'Copy failed' : 'Copy public link'}
			</button>
		{/if}
		<button type="button" class="btn-plain" onclick={() => openRename(file)}>Rename</button>
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
	{#each visibleFiles as file (file.id)}
		{@const parts = splitFilename(file.filename)}
		{#if viewMode === 'grid'}
			<li class="grid-item" class:open={openFileId === file.id}>
				<button type="button" class="grid-download" onclick={() => onFileOpen(file)}>
					<span class="grid-icon">📄</span>
					<span class="grid-name">
						<span class="grid-name-text">{parts.base}</span>
						{#if !readOnly && purgeWarning(file)}<span class="purge-warning-icon" data-tooltip={purgeWarning(file)}>⚠</span>{/if}
					</span>
					{#if parts.ext}<span class="grid-ext muted">{parts.ext}</span>{/if}
				</button>

				{#if canEdit && !file.is_journal}
					<button type="button" class="grid-actions-toggle" data-file-actions aria-label="Actions" onclick={() => toggleActions(file.id)}>
						{openActionsId === file.id ? '▴' : '▾'}
					</button>
				{/if}

				{#if canEdit && !file.is_journal && openActionsId === file.id}
					{@render actionsPanel(file)}
				{/if}

				{#if rowError?.id === file.id}
					<p class="row-error">{rowError.message}</p>
				{/if}
			</li>
		{:else}
			<li class="file-row" class:open={openFileId === file.id}>
				<div class="file-header" class:with-actions={canEdit && !file.is_journal} role="button" tabindex="0" onclick={() => onFileOpen(file)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFileOpen(file); } }}>
					<div class="cell cell-name">
						<span class="file-icon">📄</span>
						<span class="file-name-text">{parts.base}</span>
						{#if parts.ext}<span class="file-ext muted">{parts.ext}</span>{/if}
						{#if !readOnly && purgeWarning(file)}<span class="purge-warning-icon" data-tooltip={purgeWarning(file)}>⚠</span>{/if}
					</div>

					<div class="cell cell-meta muted">
						{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B` : ''}
						{#if !readOnly}
							— uploaded by {file.profiles?.display_name ?? 'a deleted account'}
						{/if}
					</div>

					{#if canEdit && !file.is_journal}
						<div class="cell cell-actions" onclick={(e) => e.stopPropagation()}>
							{@render visibilityControl(file)}
							{#if publicFilesEnabled && file.is_public}
								<button type="button" class="btn-plain" onclick={() => copyPublicLink(file)}>
									{copiedLinkId === file.id ? 'Copied' : copyLinkFailedId === file.id ? 'Copy failed' : 'Copy public link'}
								</button>
							{/if}
							<button type="button" class="btn-plain" onclick={() => openRename(file)}>Rename</button>
							<button type="button" class="btn-plain" onclick={() => openModal(file, 'move')}>Move</button>
							<button type="button" class="btn-plain" onclick={() => openModal(file, 'copy')}>Copy</button>
							<button type="button" class="btn-danger" onclick={() => handleDelete(file.id)} disabled={deletingId === file.id}>
								{deletingId === file.id ? 'Deleting…' : 'Delete'}
							</button>
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

{#if files.length > visibleFiles.length}
	<div class="window-more">
		<button type="button" class="btn-plain" onclick={showMoreFiles}>
			Show more files ({files.length - visibleFiles.length} remaining)
		</button>
	</div>
{/if}

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

{#if renameTarget}
	<RenameModal
		kind="file"
		currentName={renameTarget.filename}
		busy={renameBusy}
		error={renameError}
		onConfirm={confirmRename}
		onCancel={closeRename}
	/>
{/if}

<style>
	.file-list {
		list-style: none;
		margin: 0 0 var(--space-4);
		padding: 0;
		font-size: 0.82rem;
	}

	.window-more {
		display: flex;
		justify-content: center;
		padding: var(--space-4) 0;
	}

	.window-more button {
		font-size: 0.78rem;
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
		cursor: pointer;
	}

	.file-header:hover {
		background: var(--color-highlight);
	}

	.file-header.with-actions {
		grid-template-columns: 220px minmax(0, 1fr) auto;
	}

	.cell {
		min-width: 0;
	}

	.cell-name {
		display: flex;
		align-items: baseline;
		gap: 3px;
		min-width: 0;
		max-width: 100%;
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

	.cell-actions .file-visibility {
		flex-direction: row;
		align-items: center;
		border-bottom: none;
		padding-bottom: 0;
	}

	.cell-actions .visibility-label {
		display: none;
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

	.actions-panel .visibility-switch {
		width: auto;
	}

	.file-visibility {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: var(--space-2);
	}

	.visibility-label {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.visibility-switch {
		display: inline-flex;
		align-items: center;
		align-self: flex-start;
		gap: var(--space-2);
		width: auto;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg);
		color: var(--color-fg);
		cursor: pointer;
	}

	.visibility-switch.active {
		background: var(--color-highlight);
	}

	.visibility-switch:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}

	.visibility-switch-track {
		position: relative;
		display: block;
		width: 2rem;
		height: 1.1rem;
		border-radius: 999px;
		background: var(--color-muted);
		transition: background 0.12s ease;
	}

	.visibility-switch.active .visibility-switch-track {
		background: var(--color-highlight-strong);
	}

	.visibility-switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(1.1rem - 4px);
		height: calc(1.1rem - 4px);
		border-radius: 50%;
		background: var(--color-bg);
		transition: transform 0.12s ease;
	}

	.visibility-switch.active .visibility-switch-thumb {
		transform: translateX(0.9rem);
	}

	.visibility-switch-label {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.visibility-status {
		font-size: 0.72rem;
		margin: 0;
	}

	.file-visibility .row-error {
		padding: 0;
	}
</style>
