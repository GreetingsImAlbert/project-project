<script lang="ts">
	import { onMount } from 'svelte';

	interface Folder {
		id: string;
		name: string;
		parent_folder_id: string | null;
	}

	let {
		allFolders,
		initialFolderId,
		actionLabel,
		busy,
		error,
		onConfirm,
		onCancel,
	}: {
		allFolders: Folder[];
		initialFolderId: string | null;
		actionLabel: string;
		busy: boolean;
		error: string | null;
		onConfirm: (folderId: string | null) => void;
		onCancel: () => void;
	} = $props();

	let browseFolderId = $state(initialFolderId);

	let folderById = $derived(new Map(allFolders.map((f) => [f.id, f])));

	let subfolders = $derived(
		allFolders.filter((f) => (f.parent_folder_id ?? null) === (browseFolderId ?? null))
	);

	let breadcrumbs = $derived.by(() => {
		const crumbs: Folder[] = [];
		let cursor = browseFolderId ? folderById.get(browseFolderId) : undefined;
		while (cursor) {
			crumbs.unshift(cursor);
			cursor = cursor.parent_folder_id ? folderById.get(cursor.parent_folder_id) : undefined;
		}
		return crumbs;
	});

	function navigate(folderId: string | null) {
		browseFolderId = folderId;
	}

	onMount(() => {
		function onKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') onCancel();
		}
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});
</script>

<div class="modal-backdrop" onclick={onCancel}>
	<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
		<p class="breadcrumbs">
			<button type="button" class="crumb" onclick={() => navigate(null)}>Root</button>
			{#each breadcrumbs as crumb (crumb.id)}
				{' / '}
				<button type="button" class="crumb" onclick={() => navigate(crumb.id)}>{crumb.name}</button>
			{/each}
		</p>

		{#if subfolders.length > 0}
			<ul class="list-plain modal-folder-list">
				{#each subfolders as folder (folder.id)}
					<li><button type="button" class="btn-plain" onclick={() => navigate(folder.id)}>📁 {folder.name}</button></li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No subfolders here.</p>
		{/if}

		{#if error}<p class="row-error">{error}</p>{/if}

		<div class="modal-actions">
			<button type="button" onclick={() => onConfirm(browseFolderId)} disabled={busy}>
				{busy ? 'Working…' : actionLabel}
			</button>
			<button type="button" class="btn-plain" onclick={onCancel} disabled={busy}>Cancel</button>
		</div>
	</div>
</div>

<style>
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
		max-width: 360px;
		max-height: 80vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.crumb {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.crumb:hover {
		text-decoration: underline;
	}

	.modal-folder-list {
		margin: 0;
	}

	.modal-actions {
		display: flex;
		gap: var(--space-2);
	}

	.modal-actions button {
		flex: 1;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
