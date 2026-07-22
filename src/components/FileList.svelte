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
	}: {
		canEdit: boolean;
		currentFolderId: string | null;
		allFolders: Folder[];
		files: FileRow[];
	} = $props();

	let loadingId = $state<string | null>(null);

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
					<form method="POST" action={`/api/files/${file.id}/move`}>
						<input type="hidden" name="returnFolderId" value={currentFolderId ?? ''} />
						<select name="folderId">
							<option value="">Root</option>
							{#each allFolders as folder (folder.id)}
								<option value={folder.id} selected={folder.id === currentFolderId}>{folder.name}</option>
							{/each}
						</select>
						<button type="submit" class="btn-plain">Move</button>
					</form>
					<form method="POST" action={`/api/files/${file.id}/copy`}>
						<input type="hidden" name="returnFolderId" value={currentFolderId ?? ''} />
						<select name="folderId">
							<option value="">Root</option>
							{#each allFolders as folder (folder.id)}
								<option value={folder.id} selected={folder.id === currentFolderId}>{folder.name}</option>
							{/each}
						</select>
						<button type="submit" class="btn-plain">Copy</button>
					</form>
				</div>
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
		gap: var(--space-3);
	}

	.file-actions form {
		margin: 0;
	}
</style>