<script lang="ts">
	import { onMount } from 'svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';

	interface Folder {
		id: string;
		name: string;
		parent_folder_id: string | null;
		is_journals_folder?: boolean;
	}

	let {
		allFolders,
		initialFolderId,
		actionLabel,
		viewMode,
		busy,
		error,
		onConfirm,
		onCancel,
	}: {
		allFolders: Folder[];
		initialFolderId: string | null;
		actionLabel: string;
		viewMode: 'list' | 'grid';
		busy: boolean;
		error: string | null;
		onConfirm: (folderId: string | null) => void;
		onCancel: () => void;
	} = $props();

	let browseFolderId = $state(initialFolderId);

	let folderById = $derived(new Map(allFolders.map((f) => [f.id, f])));

	let subfolders = $derived(
		allFolders.filter((f) => !f.is_journals_folder && (f.parent_folder_id ?? null) === (browseFolderId ?? null))
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
		return onSwapOrDestroy(() => window.removeEventListener('keydown', onKeydown));
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
			<ul class={viewMode === 'grid' ? 'grid-view' : 'file-list'}>
				{#each subfolders as folder (folder.id)}
					{#if viewMode === 'grid'}
						<li class="grid-item">
							<button type="button" class="grid-download" onclick={() => navigate(folder.id)}>
								<span class="grid-icon">📁</span>
								<span class="grid-name">{folder.name}</span>
							</button>
						</li>
					{:else}
						<li class="file-row">
							<button type="button" class="btn-plain" onclick={() => navigate(folder.id)}>📁 {folder.name}</button>
						</li>
					{/if}
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
		max-width: 680px;
		max-height: 70vh;
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
