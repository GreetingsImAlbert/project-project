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
		onFileMoved,
		onFileCopied,
	}: {
		canEdit: boolean;
		currentFolderId: string | null;
		allFolders: Folder[];
		files: FileRow[];
		onFileMoved: (fileId: string, targetFolderId: string | null) => void;
		onFileCopied: (file: FileRow, targetFolderId: string | null) => void;
	} = $props();

	let loadingId = $state<string | null>(null);
	let movingId = $state<string | null>(null);
	let copyingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

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
	}
</script>

{#if files.length === 0}
	<p class="muted">No files here.</p>
{/if}

<ul class="list-plain">
	{#each files as file (file.id)}
		<li class="file-row">
			<div class="file-main">
				<button type="button" class="btn-plain" onclick={() => download(file)} disabled={loadingId === file.id}>
					{loadingId === file.id ? 'Loading…' : file.filename}
				</button>
				<span class="muted">
					{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B` : ''}
					— uploaded by {file.profiles?.display_name}
				</span>
			</div>

			{#if canEdit}
				<div class="file-actions">
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
				</div>
			{/if}

			{#if rowError?.id === file.id}
				<p class="row-error">{rowError.message}</p>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.file-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.file-main {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
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
</style>