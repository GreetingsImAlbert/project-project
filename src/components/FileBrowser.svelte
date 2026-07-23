<script lang="ts">
	import { onMount } from 'svelte';
	import FileList from './FileList.svelte';
	import UploadForm from './UploadForm.svelte';

	interface Folder {
		id: string;
		name: string;
		parent_folder_id: string | null;
	}

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		profiles: { display_name: string } | null;
	}

	let {
		projectId,
		canEdit,
		initialAllFolders,
		initialFolderId,
		initialFiles,
	}: {
		projectId: string;
		canEdit: boolean;
		initialAllFolders: Folder[];
		initialFolderId: string | null;
		initialFiles: FileRow[];
	} = $props();

	let currentFolderId = $state(initialFolderId);
	let files = $state(initialFiles);
	let allFolders = $state(initialAllFolders);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let viewMode = $state<'list' | 'grid'>('list');

	let creatingFolder = $state(false);
	let createFolderError = $state<string | null>(null);
	let deletingFolderId = $state<string | null>(null);
	let folderError = $state<{ id: string; message: string } | null>(null);

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
	}

	function hrefFor(folderId: string | null) {
		return folderId ? `/projects/${projectId}?folder=${folderId}` : `/projects/${projectId}`;
	}

	async function navigate(folderId: string | null, pushState = true) {
		if (folderId === currentFolderId) return;

		loading = true;
		error = null;

		const url = folderId
			? `/api/projects/${projectId}/files?folderId=${folderId}`
			: `/api/projects/${projectId}/files`;

		const res = await fetch(url);

		if (!res.ok) {
			error = await res.text();
			loading = false;
			return;
		}

		files = await res.json();
		currentFolderId = folderId;
		loading = false;

		if (pushState) {
			history.pushState({ folderId }, '', hrefFor(folderId));
		}
	}

	function handleLinkClick(e: MouseEvent, folderId: string | null) {
		e.preventDefault();
		navigate(folderId);
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
	}

	function handleUploaded(file: FileRow) {
		files = [...files, file];
	}

	function handleFileDeleted(fileId: string) {
		files = files.filter((f) => f.id !== fileId);
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
	}

	onMount(() => {
		const stored = localStorage.getItem('p2-file-view-mode');
		if (stored === 'grid' || stored === 'list') viewMode = stored;

		const onPopState = () => {
			const folderId = new URLSearchParams(location.search).get('folder');
			navigate(folderId, false);
		};
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	});
</script>

<div class="browser-header">
	<div class="breadcrumb-group">
		<button type="button" class="btn-plain nav-btn" onclick={() => history.back()}>← Back</button>
		<button type="button" class="btn-plain nav-btn" onclick={() => navigate(parentFolderId)} disabled={currentFolderId === null}>↑ Up</button>
		<p class="breadcrumbs">
			<a href={hrefFor(null)} onclick={(e) => handleLinkClick(e, null)}>Root</a>
			{#each breadcrumbs as crumb (crumb.id)}
				{' / '}
				<a href={hrefFor(crumb.id)} onclick={(e) => handleLinkClick(e, crumb.id)}>{crumb.name}</a>
			{/each}
		</p>
	</div>

	{#if canEdit}
		<form class="create-folder-form" onsubmit={handleCreateFolder} action={`/api/projects/${projectId}/folders/create`}>
			<input type="hidden" name="parentFolderId" value={currentFolderId ?? ''} />
			<input type="text" name="name" placeholder="New folder name" required />
			<button type="submit" disabled={creatingFolder}>{creatingFolder ? 'Creating…' : 'Create folder'}</button>
		</form>
	{/if}
</div>
{#if createFolderError}<p class="row-error">{createFolderError}</p>{/if}

{#if subfolders.length > 0}
	<ul class="list-plain folder-list">
		{#each subfolders as folder (folder.id)}
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
		{/each}
	</ul>
{/if}

{#if error}<p class="row-error">{error}</p>{/if}

<div class="view-toggle">
	<button type="button" class="btn-plain" class:active={viewMode === 'list'} onclick={() => setViewMode('list')}>List</button>
	<button type="button" class="btn-plain" class:active={viewMode === 'grid'} onclick={() => setViewMode('grid')}>Grid</button>
</div>

<FileList
	canEdit={canEdit}
	currentFolderId={currentFolderId}
	allFolders={allFolders}
	files={loading ? [] : files}
	viewMode={viewMode}
	onFileMoved={handleFileMoved}
	onFileCopied={handleFileCopied}
	onFileDeleted={handleFileDeleted}
/>
{#if loading}<p class="muted">Loading…</p>{/if}

{#if canEdit}
	<UploadForm projectId={projectId} currentFolderId={currentFolderId} onUploaded={handleUploaded} />
{/if}

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
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.breadcrumb-group .breadcrumbs {
		margin: 0;
	}

	.nav-btn {
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
	}

	.create-folder-form {
		margin: 0;
	}

	.view-toggle {
		display: flex;
		gap: var(--space-2);
		margin: 0 0 var(--space-3);
	}

	.view-toggle button {
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
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

	.row-error-item {
		color: var(--color-danger);
		border-top: none;
		padding-top: 0;
	}

	.row-error {
		color: var(--color-danger);
	}
</style>