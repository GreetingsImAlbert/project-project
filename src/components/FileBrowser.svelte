<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import FileList from './FileList.svelte';
	import UploadForm from './UploadForm.svelte';
	import ProjectStorageUsed from './ProjectStorageUsed.svelte';
	import { adjustProjectStorage } from '../lib/project-storage.svelte';

	interface Folder {
		id: string;
		name: string;
		parent_folder_id: string | null;
	}

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		uploaded_by: string;
		profiles: { display_name: string } | null;
	}

	let {
		projectId,
		currentUserId,
		canEdit,
		initialAllFolders,
		initialFolderId,
		initialFiles,
		initialAvailableBytes,
		initialViewMode,
		initialStorageBytes,
		initialStorageFailed,
	}: {
		projectId: string;
		currentUserId: string;
		canEdit: boolean;
		initialAllFolders: Folder[];
		initialFolderId: string | null;
		initialFiles: FileRow[];
		initialAvailableBytes: number | null;
		initialViewMode?: 'list' | 'grid';
		initialStorageBytes: number;
		initialStorageFailed: boolean;
	} = $props();

	let currentFolderId = $state(initialFolderId);
	let files = $state(initialFiles);
	let allFolders = $state(initialAllFolders);
	let availableBytes = $state(initialAvailableBytes);
	let loading = $state(false);
	let error = $state<string | null>(null);
	function getInitialViewMode(): 'list' | 'grid' {
		if (initialViewMode) return initialViewMode;
		if (typeof localStorage === 'undefined') return 'grid';
		return localStorage.getItem('p2-file-view-mode') === 'list' ? 'list' : 'grid';
	}

	let viewMode = $state<'list' | 'grid'>(getInitialViewMode());
	let backStack = $state<(string | null)[]>([]);

	let creatingFolder = $state(false);
	let createFolderError = $state<string | null>(null);
	let deletingFolderId = $state<string | null>(null);
	let folderError = $state<{ id: string; message: string } | null>(null);
	let openFolderActionsId = $state<string | null>(null);

	function toggleFolderActions(folderId: string) {
		openFolderActionsId = openFolderActionsId === folderId ? null : folderId;
	}

	let folderById = $derived(new Map(allFolders.map((f) => [f.id, f])));

	let subfolders = $derived(
		allFolders.filter((f) => (f.parent_folder_id ?? null) === (currentFolderId ?? null))
	);

	let breadcrumbs = $derived.by(() => {
		const crumbs: Folder[] = [];
		let cursor = currentFolderId ? folderById.get(currentFolderId) : undefined;
		while (cursor) {
			crumbs.unshift(cursor);
			cursor = cursor.parent_folder_id ? folderById.get(cursor.parent_folder_id) : undefined;
		}
		return crumbs;
	});

	let parentFolderId = $derived(
		breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].parent_folder_id : null
	);

	function setViewMode(mode: 'list' | 'grid') {
		viewMode = mode;
		localStorage.setItem('p2-file-view-mode', mode);
		document.cookie = `p2-file-view-mode=${mode}; path=/; max-age=31536000; samesite=lax`;
	}

	function hrefFor(folderId: string | null) {
		return folderId ? `/projects/${projectId}/files?folder=${folderId}` : `/projects/${projectId}/files`;
	}

	// Bumped on every navigate() call so a stale response from an earlier click (e.g. two
	// folders clicked in quick succession) can't overwrite a newer one that already resolved.
	let requestSeq = 0;

	async function navigate(folderId: string | null, historyMode: 'push' | 'replace' | 'none' = 'push') {
		if (folderId === currentFolderId) return;

		const requestId = ++requestSeq;
		loading = true;
		error = null;

		const url = folderId
			? `/api/projects/${projectId}/files?folderId=${folderId}`
			: `/api/projects/${projectId}/files`;

		const res = await fetch(url);

		if (requestId !== requestSeq) return;

		if (!res.ok) {
			error = await res.text();
			loading = false;
			return;
		}

		files = await res.json();
		currentFolderId = folderId;
		loading = false;

		if (historyMode === 'push') {
			history.pushState({ folderId }, '', hrefFor(folderId));
		} else if (historyMode === 'replace') {
			history.replaceState({ folderId }, '', hrefFor(folderId));
		}
	}

	function navigateWithHistory(folderId: string | null) {
		if (folderId === currentFolderId || loading) return;
		backStack = [...backStack, currentFolderId];
		navigate(folderId, 'push');
	}

	function goBack() {
		if (backStack.length === 0 || loading) return;
		const previous = backStack[backStack.length - 1];
		backStack = backStack.slice(0, -1);
		// 'replace', not 'push' — this is going back, not forward, so the URL should reflect
		// the folder we land on without growing the real browser history stack (that stack
		// is what the native Back/Forward buttons use, and shouldn't gain a duplicate entry
		// every time the in-app Back button is clicked).
		navigate(previous, 'replace');
	}

	function handleLinkClick(e: MouseEvent, folderId: string | null) {
		e.preventDefault();
		navigateWithHistory(folderId);
	}

	function handleFileMoved(fileId: string, targetFolderId: string | null) {
		if (targetFolderId !== currentFolderId) {
			files = files.filter((f) => f.id !== fileId);
		}
	}

	function handleFileCopied(file: FileRow, targetFolderId: string | null) {
		if (targetFolderId === currentFolderId) {
			files = [...files, file];
		}
		adjustProjectStorage(file.size_bytes ?? 0);
		// copy.ts always attributes the copy to the current user (uploaded_by is
		// the copier, not the source file's original uploader), so this always
		// consumes the current viewer's own quota regardless of the destination.
		// availableBytes stays null (unknown) if the initial read already failed.
		if (availableBytes !== null) availableBytes -= file.size_bytes ?? 0;
	}

	function handleUploaded(file: FileRow) {
		files = [...files, file];
		if (availableBytes !== null) availableBytes -= file.size_bytes ?? 0;
		adjustProjectStorage(file.size_bytes ?? 0);
	}

	function handleFileDeleted(fileId: string) {
		const deletedFile = files.find((f) => f.id === fileId);
		files = files.filter((f) => f.id !== fileId);
		adjustProjectStorage(-(deletedFile?.size_bytes ?? 0));
		// Only give quota back to the current viewer if it was actually their own
		// file — deleting a project-mate's upload frees their quota, not ours.
		if (deletedFile?.uploaded_by === currentUserId && availableBytes !== null) {
			availableBytes += deletedFile?.size_bytes ?? 0;
		}
	}

	async function handleCreateFolder(e: SubmitEvent) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;

		creatingFolder = true;
		createFolderError = null;

		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			createFolderError = await res.text();
			creatingFolder = false;
			return;
		}

		const created: Folder = await res.json();
		allFolders = [...allFolders, created];
		form.reset();
		creatingFolder = false;
	}

	async function handleDeleteFolder(folderId: string) {
		if (!confirm('Delete this folder?')) return;

		folderError = null;
		deletingFolderId = folderId;

		const res = await fetch(`/api/projects/${projectId}/folders/${folderId}/delete`, { method: 'POST' });

		if (!res.ok) {
			folderError = { id: folderId, message: await res.text() };
			deletingFolderId = null;
			return;
		}

		allFolders = allFolders.filter((f) => f.id !== folderId);
		deletingFolderId = null;
		openFolderActionsId = null;
	}

	onMount(() => {
		const onPopState = () => {
			const folderId = new URLSearchParams(location.search).get('folder');
			navigate(folderId, 'none');
		};
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	});
</script>

<div class="browser-meta">
	<ProjectStorageUsed initialUsedBytes={initialStorageBytes} initialFailed={initialStorageFailed} />

	<div class="view-toggle">
		<button
			type="button"
			class="btn-plain"
			class:active={viewMode === 'grid'}
			aria-pressed={viewMode === 'grid'}
			aria-label="Grid view"
			title="Grid view"
			onclick={() => setViewMode('grid')}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<rect x="1" y="1" width="6" height="6" rx="1" />
				<rect x="9" y="1" width="6" height="6" rx="1" />
				<rect x="1" y="9" width="6" height="6" rx="1" />
				<rect x="9" y="9" width="6" height="6" rx="1" />
			</svg>
		</button>
		<button
			type="button"
			class="btn-plain"
			class:active={viewMode === 'list'}
			aria-pressed={viewMode === 'list'}
			aria-label="List view"
			title="List view"
			onclick={() => setViewMode('list')}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<rect x="1" y="2" width="2" height="2" rx="0.5" />
				<rect x="5" y="2" width="10" height="2" rx="1" />
				<rect x="1" y="7" width="2" height="2" rx="0.5" />
				<rect x="5" y="7" width="10" height="2" rx="1" />
				<rect x="1" y="12" width="2" height="2" rx="0.5" />
				<rect x="5" y="12" width="10" height="2" rx="1" />
			</svg>
		</button>
	</div>
</div>

<div class="browser-header">
	<div class="breadcrumb-group">
		<button type="button" class="btn-plain nav-btn" onclick={goBack} disabled={backStack.length === 0}>← Back</button>
		<button type="button" class="btn-plain nav-btn" onclick={() => navigateWithHistory(parentFolderId)} disabled={currentFolderId === null}>↑ Up</button>
		<p class="breadcrumbs">
			<a href={hrefFor(null)} onclick={(e) => handleLinkClick(e, null)}>Root</a>
			{#each breadcrumbs as crumb (crumb.id)}
				{' / '}
				<a href={hrefFor(crumb.id)} onclick={(e) => handleLinkClick(e, crumb.id)}>{crumb.name}</a>
			{/each}
		</p>
	</div>

	{#if canEdit}
		<div class="header-actions">
			<form class="create-folder-form" onsubmit={handleCreateFolder} action={`/api/projects/${projectId}/folders/create`}>
				<input type="hidden" name="parentFolderId" value={currentFolderId ?? ''} />
				<input type="text" name="name" placeholder="New folder name" required />
				<button type="submit" disabled={creatingFolder}>{creatingFolder ? 'Creating…' : 'Create folder'}</button>
			</form>

			<UploadForm projectId={projectId} currentFolderId={currentFolderId} availableBytes={availableBytes} onUploaded={handleUploaded} />
		</div>
	{/if}
</div>
{#if createFolderError}<p class="row-error">{createFolderError}</p>{/if}

{#if subfolders.length > 0}
	<ul class={viewMode === 'grid' ? 'grid-view' : 'list-plain folder-list'}>
		{#each subfolders as folder (folder.id)}
			{#if viewMode === 'grid'}
				<li class="grid-item">
					<a href={hrefFor(folder.id)} onclick={(e) => handleLinkClick(e, folder.id)} class="grid-download">
						<span class="grid-icon">📁</span>
						<span class="grid-name">{folder.name}</span>
					</a>

					{#if canEdit}
						<button type="button" class="grid-actions-toggle" aria-label="Actions" onclick={() => toggleFolderActions(folder.id)}>
							{openFolderActionsId === folder.id ? '▴' : '▾'}
						</button>
					{/if}

					{#if canEdit && openFolderActionsId === folder.id}
						<div class="actions-panel" transition:slide={{ duration: 150 }}>
							<button type="button" class="btn-danger" onclick={() => handleDeleteFolder(folder.id)} disabled={deletingFolderId === folder.id}>
								{deletingFolderId === folder.id ? 'Deleting…' : 'Delete'}
							</button>
						</div>
					{/if}

					{#if folderError?.id === folder.id}
						<p class="row-error">{folderError.message}</p>
					{/if}
				</li>
			{:else}
				<li class="folder-row">
					<a href={hrefFor(folder.id)} onclick={(e) => handleLinkClick(e, folder.id)}>📁 {folder.name}</a>
					{#if canEdit}
						<button type="button" class="btn-danger" onclick={() => handleDeleteFolder(folder.id)} disabled={deletingFolderId === folder.id}>
							{deletingFolderId === folder.id ? 'Deleting…' : 'Delete'}
						</button>
					{/if}
				</li>
				{#if folderError?.id === folder.id}
					<li class="row-error-item">{folderError.message}</li>
				{/if}
			{/if}
		{/each}
	</ul>
{/if}

{#if error}<p class="row-error">{error}</p>{/if}

<FileList
	canEdit={canEdit}
	currentFolderId={currentFolderId}
	allFolders={allFolders}
	files={loading ? [] : files}
	viewMode={viewMode}
	loading={loading}
	onFileMoved={handleFileMoved}
	onFileCopied={handleFileCopied}
	onFileDeleted={handleFileDeleted}
/>
{#if loading}<p class="muted">Loading…</p>{/if}

<style>
	.browser-header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-3);
	}

	.breadcrumb-group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: 1 1 200px;
		min-width: 0;
	}

	.breadcrumb-group .breadcrumbs {
		margin: 0;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		-webkit-mask-image: linear-gradient(to right, black calc(100% - 32px), transparent 100%);
		mask-image: linear-gradient(to right, black calc(100% - 32px), transparent 100%);
	}

	.nav-btn {
		flex: 0 0 auto;
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
	}

	.header-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-3);
		flex: 0 0 auto;
	}

	.create-folder-form {
		margin: 0;
	}

	.create-folder-form input[type='text'] {
		width: 220px;
		max-width: 100%;
		box-sizing: border-box;
	}

	@media (max-width: 640px) {
		.browser-header {
			flex-direction: column;
			align-items: stretch;
		}

		.breadcrumb-group {
			flex-basis: auto;
		}
	}

	.browser-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.browser-meta :global(p) {
		margin: 0;
	}

	.view-toggle {
		display: flex;
		gap: var(--space-2);
		flex: 0 0 auto;
	}

	.view-toggle button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-1);
		line-height: 0;
	}

	.view-toggle svg {
		width: 14px;
		height: 14px;
		fill: currentColor;
	}

	.view-toggle button.active {
		background: var(--color-fg);
		color: var(--color-bg);
	}

	.folder-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

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

	.grid-download {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		color: var(--color-fg);
		border-bottom: none;
	}

	.grid-download:hover {
		border-bottom: none;
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

	.row-error-item {
		color: var(--color-danger);
		border-top: none;
		padding-top: 0;
	}

	.row-error {
		color: var(--color-danger);
	}
</style>