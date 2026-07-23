<script lang="ts">
	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		profiles: { display_name: string } | null;
	}

	interface Folder {
		id: string;
		name: string;
	}

	let {
		canEdit,
		currentFolderId,
		allFolders,
		files,
		viewMode,
		onFileMoved,
		onFileCopied,
		onFileDeleted,
	}: {
		canEdit: boolean;
		currentFolderId: string | null;
		allFolders: Folder[];
		files: FileRow[];
		viewMode: 'list' | 'grid';
		onFileMoved: (fileId: string, targetFolderId: string | null) => void;
		onFileCopied: (file: FileRow, targetFolderId: string | null) => void;
		onFileDeleted: (fileId: string) => void;
	} = $props();

	let loadingId = $state<string | null>(null);
	let movingId = $state<string | null>(null);
	let copyingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let openActionsId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	function toggleActions(fileId: string) {
		openActionsId = openActionsId === fileId ? null : fileId;
	}

	let moveSelectEls: Record<string, HTMLSelectElement> = {};
	let copySelectEls: Record<string, HTMLSelectElement> = {};

	async function download(file: FileRow) {
		loadingId = file.id;
		const res = await fetch(`/api/files/${file.id}/download-url`);

		if (!res.ok) {
			alert('Failed to get download link');
			loadingId = null;
			return;
		}

		const { downloadUrl } = await res.json();
		window.location.href = downloadUrl;
		loadingId = null;
	}

	async function handleMove(fileId: string) {
		const targetFolderId = moveSelectEls[fileId]?.value || null;
		rowError = null;
		movingId = fileId;

		const res = await fetch(`/api/files/${fileId}/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ folderId: targetFolderId }),
		});

		if (!res.ok) {
			rowError = { id: fileId, message: await res.text() };
			movingId = null;
			return;
		}

		onFileMoved(fileId, targetFolderId);
		movingId = null;
		openActionsId = null;
	}

	async function handleCopy(fileId: string) {
		const targetFolderId = copySelectEls[fileId]?.value || null;
		rowError = null;
		copyingId = fileId;

		const res = await fetch(`/api/files/${fileId}/copy`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ folderId: targetFolderId }),
		});

		if (!res.ok) {
			rowError = { id: fileId, message: await res.text() };
			copyingId = null;
			return;
		}

		const copied: FileRow = await res.json();
		onFileCopied(copied, targetFolderId);
		copyingId = null;
		openActionsId = null;
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
	<div class="file-action-group">
		<select bind:this={moveSelectEls[file.id]}>
			<option value="">Root</option>
			{#each allFolders as folder (folder.id)}
				<option value={folder.id} selected={folder.id === currentFolderId}>{folder.name}</option>
			{/each}
		</select>
		<button type="button" class="btn-plain" onclick={() => handleMove(file.id)} disabled={movingId === file.id}>
			{movingId === file.id ? 'Moving…' : 'Move'}
		</button>
	</div>
	<div class="file-action-group">
		<select bind:this={copySelectEls[file.id]}>
			<option value="">Root</option>
			{#each allFolders as folder (folder.id)}
				<option value={folder.id} selected={folder.id === currentFolderId}>{folder.name}</option>
			{/each}
		</select>
		<button type="button" class="btn-plain" onclick={() => handleCopy(file.id)} disabled={copyingId === file.id}>
			{copyingId === file.id ? 'Copying…' : 'Copy'}
		</button>
	</div>
	<button type="button" class="btn-danger" onclick={() => handleDelete(file.id)} disabled={deletingId === file.id}>
		{deletingId === file.id ? 'Deleting…' : 'Delete'}
	</button>
{/snippet}

{#if files.length === 0}
	<p class="muted">No files here.</p>
{/if}

<ul class={viewMode === 'grid' ? 'grid-view' : 'file-list'}>
	{#each files as file (file.id)}
		{#if viewMode === 'grid'}
			<li class="grid-item">
				<button type="button" class="grid-download" onclick={() => download(file)} disabled={loadingId === file.id}>
					<span class="grid-icon">📄</span>
					<span class="grid-name">{loadingId === file.id ? 'Loading…' : file.filename}</span>
				</button>

				{#if canEdit}
					<button type="button" class="grid-actions-toggle" aria-label="Actions" onclick={() => toggleActions(file.id)}>
						{openActionsId === file.id ? '▴' : '▾'}
					</button>
				{/if}

				{#if canEdit && openActionsId === file.id}
					<div class="file-actions grid-actions">
						{@render actionsPanel(file)}
					</div>
				{/if}

				{#if rowError?.id === file.id}
					<p class="row-error">{rowError.message}</p>
				{/if}
			</li>
		{:else}
			<li class="file-row">
				<div class="file-header">
					<div class="file-main">
						<button type="button" class="btn-plain" onclick={() => download(file)} disabled={loadingId === file.id}>
							{loadingId === file.id ? 'Loading…' : file.filename}
						</button>
						<span class="muted file-meta">
							{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B` : ''}
							— uploaded by {file.profiles?.display_name}
						</span>
					</div>

					{#if canEdit}
						<button type="button" class="btn-plain actions-toggle" onclick={() => toggleActions(file.id)}>
							Actions {openActionsId === file.id ? '▴' : '▾'}
						</button>
					{/if}
				</div>

				{#if canEdit && openActionsId === file.id}
					<div class="file-actions">
						{@render actionsPanel(file)}
					</div>
				{/if}

				{#if rowError?.id === file.id}
					<p class="row-error">{rowError.message}</p>
				{/if}
			</li>
		{/if}
	{/each}
</ul>

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
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
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
		align-items: baseline;
		gap: var(--space-2);
	}

	.file-meta {
		font-size: 0.8rem;
	}

	.file-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
	}

	.file-action-group {
		display: flex;
		gap: var(--space-2);
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

	.grid-actions {
		flex-direction: column;
		width: 100%;
		gap: var(--space-2);
	}

	.grid-actions .file-action-group {
		flex-direction: column;
		gap: var(--space-1);
	}

	.grid-actions select {
		width: 100%;
		min-width: 0;
	}
</style>