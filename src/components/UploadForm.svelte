<script lang="ts">
	import { formatBytes } from '../lib/format-bytes';

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		uploaded_by: string;
		profiles: { display_name: string } | null;
	}

	let {
		projectId,
		currentFolderId,
		availableBytes,
		onUploaded,
	}: {
		projectId: string;
		currentFolderId: string | null;
		availableBytes: number;
		onUploaded: (file: FileRow) => void;
	} = $props();

	let status = $state('');
	let uploading = $state(false);
	let dragging = $state(false);
	let selectedFile: File | null = $state(null);
	let fileInput: HTMLInputElement | undefined = $state();

	function openPicker() {
		fileInput?.click();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			openPicker();
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragging = true;
	}

	function handleDragLeave() {
		dragging = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) selectedFile = file;
	}

	function handleFileInputChange() {
		selectedFile = fileInput?.files?.[0] ?? null;
	}

	function clearSelectedFile(e: MouseEvent) {
		e.stopPropagation();
		selectedFile = null;
		if (fileInput) fileInput.value = '';
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		const file = selectedFile;
		if (!file) return;

		uploading = true;
		status = 'Requesting upload URL...';

		const urlRes = await fetch(`/api/projects/${projectId}/files/upload-url`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: file.name, size: file.size }),
		});

		if (!urlRes.ok) {
			status = 'Failed to get upload URL: ' + (await urlRes.text());
			uploading = false;
			return;
		}

		const { uploadUrl, r2Key } = await urlRes.json();

		status = 'Uploading...';

		const putRes = await fetch(uploadUrl, {
			method: 'PUT',
			body: file,
		});

		if (!putRes.ok) {
			status = 'Upload to R2 failed';
			uploading = false;
			return;
		}

		status = 'Saving file record...';

		const confirmRes = await fetch(`/api/projects/${projectId}/files/confirm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				r2Key,
				filename: file.name,
				size: file.size,
				mimeType: file.type,
				folderId: currentFolderId,
			}),
		});

		if (confirmRes.ok) {
			const created: FileRow = await confirmRes.json();
			onUploaded(created);
			status = 'Upload complete!';
			selectedFile = null;
			if (fileInput) fileInput.value = '';
		} else {
			const result: { cleanedUp: boolean; error: string } = await confirmRes.json();
			status = result.cleanedUp
				? `Upload failed (cleaned up): ${result.error}`
				: `Upload failed AND cleanup failed: ${result.error}`;
		}

		uploading = false;
	}
</script>

<div class="upload-form">
	<p class="muted available-space">Available: {formatBytes(Math.max(availableBytes, 0))}</p>
	<form onsubmit={handleSubmit}>
		<input type="file" bind:this={fileInput} onchange={handleFileInputChange} class="visually-hidden" tabindex="-1" />
		<div
			class="dropzone"
			class:dragging
			class:has-file={!!selectedFile}
			role="button"
			tabindex="0"
			onclick={openPicker}
			onkeydown={handleKeydown}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			<span class="dropzone-text">{selectedFile ? selectedFile.name : 'Drag or Choose File'}</span>
			{#if selectedFile}
				<button type="button" class="clear-btn" aria-label="Remove selected file" onclick={clearSelectedFile}>×</button>
			{/if}
		</div>
		<button type="submit" disabled={uploading || !selectedFile}>Upload</button>
	</form>
	{#if status}<p class="muted">{status}</p>{/if}
</div>

<style>
	.upload-form {
		position: relative;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.dropzone {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 220px;
		max-width: 100%;
		box-sizing: border-box;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		padding: var(--space-2) var(--space-3);
		color: var(--color-muted);
		cursor: pointer;
	}

	.dropzone-text {
		flex: 1 1 auto;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dropzone.dragging {
		border-color: var(--color-border-strong);
	}

	.dropzone.has-file {
		color: var(--color-fg);
	}

	.clear-btn {
		flex: 0 0 auto;
		background: none;
		border: none;
		padding: 0 0 0 var(--space-1);
		color: var(--color-muted);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
	}

	.clear-btn:hover {
		color: var(--color-danger);
	}

	.available-space {
		position: absolute;
		bottom: 100%;
		left: 0;
		margin: 0 0 var(--space-1);
		font-size: 0.8rem;
		white-space: nowrap;
	}
</style>