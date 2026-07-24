<script lang="ts">
	import { onMount } from 'svelte';

	interface MyFile {
		id: string;
		filename: string;
		size_bytes: number | null;
		project_id: string;
		projects: { name: string } | null;
	}

	let { projectId }: { projectId?: string } = $props();

	let open = $state(false);
	let viewMode = $state<'list' | 'grid'>('grid');
	let files = $state<MyFile[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	function splitName(filename: string): { base: string; ext: string } {
		const idx = filename.lastIndexOf('.');
		if (idx <= 0) return { base: filename, ext: '' };
		return { base: filename.slice(0, idx), ext: filename.slice(idx) };
	}

	async function openModal() {
		open = true;

		const stored = localStorage.getItem('p2-file-view-mode');
		if (stored === 'grid' || stored === 'list') viewMode = stored;

		loading = true;
		loadError = null;

		const res = await fetch('/api/files/mine');

		if (!res.ok) {
			loadError = await res.text();
			loading = false;
			return;
		}

		const fetched: MyFile[] = await res.json();
		// Array.prototype.sort is stable, so ties (both current-project or both
		// not) keep the API's created_at desc order.
		files = fetched.sort((a, b) => {
			const aCurrent = a.project_id === projectId ? 0 : 1;
			const bCurrent = b.project_id === projectId ? 0 : 1;
			return aCurrent - bCurrent;
		});
		loading = false;
	}

	function closeModal() {
		open = false;
	}

	async function download(file: MyFile) {
		const res = await fetch(`/api/files/${file.id}/download-url`);

		if (!res.ok) {
			alert('Failed to get download link');
			return;
		}

		const { downloadUrl } = await res.json();
		window.location.href = downloadUrl;
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

		files = files.filter((f) => f.id !== fileId);
		deletingId = null;
	}

	onMount(() => {
		function onKeydown(e: KeyboardEvent) {
			if (open && e.key === 'Escape') closeModal();
		}
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});
</script>

<button type="button" class="open-link" onclick={openModal} aria-label="View your uploaded files">↗</button>

{#if open}
	<div class="modal-backdrop" onclick={closeModal}>
		<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Your files</h3>
				<button type="button" class="btn-plain" onclick={closeModal}>Close</button>
			</div>

			{#if loading}
				<p class="muted">Loading…</p>
			{:else if loadError}
				<p class="row-error">{loadError}</p>
			{:else if files.length === 0}
				<p class="muted">You haven't uploaded any files yet.</p>
			{:else}
				<ul class={viewMode === 'grid' ? 'grid-view' : 'file-list'}>
					{#each files as file (file.id)}
						{@const parts = splitName(file.filename)}
						{#if viewMode === 'grid'}
							<li class="grid-item">
								<button type="button" class="grid-download" onclick={() => download(file)}>
									<span class="grid-icon">📄</span>
									<span class="grid-name">{parts.base}</span>
									{#if parts.ext}<span class="grid-ext muted">{parts.ext}</span>{/if}
								</button>
								<span class="grid-project muted" class:current-project={file.project_id === projectId}>{file.projects?.name}</span>
								<button
									type="button"
									class="trash-btn"
									aria-label="Delete file"
									onclick={() => handleDelete(file.id)}
									disabled={deletingId === file.id}
								>
									🗑
								</button>
								{#if rowError?.id === file.id}<p class="row-error">{rowError.message}</p>{/if}
							</li>
						{:else}
							<li class="file-row">
								<button type="button" class="btn-plain file-download" onclick={() => download(file)}>
									<span class="file-name">{parts.base}</span>
									{#if parts.ext}<span class="file-ext muted">{parts.ext}</span>{/if}
								</button>
								<span class="muted file-meta">
									{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B` : ''}
									— <span class:current-project={file.project_id === projectId}>{file.projects?.name}</span>
								</span>
								<button
									type="button"
									class="trash-btn"
									aria-label="Delete file"
									onclick={() => handleDelete(file.id)}
									disabled={deletingId === file.id}
								>
									🗑
								</button>
								{#if rowError?.id === file.id}<p class="row-error">{rowError.message}</p>{/if}
							</li>
						{/if}
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.open-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--color-muted);
		cursor: pointer;
	}

	.open-link:hover {
		color: var(--color-fg);
	}

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

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.modal-header h3 {
		margin: 0;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}

	.current-project {
		font-weight: 700;
		color: var(--color-fg);
	}

	.trash-btn {
		background: none;
		border: none;
		padding: 0 var(--space-1);
		color: var(--color-muted);
		font-size: 1rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.trash-btn:hover {
		color: var(--color-danger);
	}

	/* List view */

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

	.file-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.file-download {
		display: flex;
		align-items: baseline;
		gap: var(--space-1);
	}

	.file-meta {
		font-size: 0.8rem;
		flex: 1 1 auto;
	}

	/* Grid view */

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

	.grid-ext {
		font-size: 0.7rem;
	}

	.grid-project {
		font-size: 0.7rem;
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
