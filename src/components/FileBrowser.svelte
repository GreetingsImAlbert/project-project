<script lang="ts">
	import { onMount } from 'svelte';
	import FileList from './FileList.svelte';

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
		allFolders,
		initialFolderId,
		initialFiles,
	}: {
		projectId: string;
		canEdit: boolean;
		allFolders: Folder[];
		initialFolderId: string | null;
		initialFiles: FileRow[];
	} = $props();

	let currentFolderId = $state(initialFolderId);
	let files = $state(initialFiles);
	let loading = $state(false);
	let error = $state<string | null>(null);

	const folderById = new Map(allFolders.map((f) => [f.id, f]));

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

	onMount(() => {
		const onPopState = () => {
			const folderId = new URLSearchParams(location.search).get('folder');
			navigate(folderId, false);
		};
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	});
</script>

<p class="breadcrumbs">
	<a href={hrefFor(null)} onclick={(e) => handleLinkClick(e, null)}>Root</a>
	{#each breadcrumbs as crumb (crumb.id)}
		{' / '}
		<a href={hrefFor(crumb.id)} onclick={(e) => handleLinkClick(e, crumb.id)}>{crumb.name}</a>
	{/each}
</p>

{#if subfolders.length > 0}
	<ul class="list-plain folder-list">
		{#each subfolders as folder (folder.id)}
			<li class="folder-row">
				<a href={hrefFor(folder.id)} onclick={(e) => handleLinkClick(e, folder.id)}>📁 {folder.name}</a>
				{#if canEdit}
					<form method="POST" action={`/api/projects/${projectId}/folders/${folder.id}/delete`}>
						<button type="submit" class="btn-danger">Delete</button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

{#if canEdit}
	<form method="POST" action={`/api/projects/${projectId}/folders/create`} onsubmit={(e) => (e.currentTarget.querySelector('button')!.disabled = true)}>
		<input type="hidden" name="parentFolderId" value={currentFolderId ?? ''} />
		<input type="text" name="name" placeholder="New folder name" required />
		<button type="submit">Create folder</button>
	</form>
{/if}

{#if error}<p class="save-error">{error}</p>{/if}

<FileList canEdit={canEdit} currentFolderId={currentFolderId} allFolders={allFolders} files={loading ? [] : files} />
{#if loading}<p class="muted">Loading…</p>{/if}

<style>
	.folder-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.folder-row form {
		margin: 0;
	}

	.save-error {
		color: var(--color-danger);
	}
</style>