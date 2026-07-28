<script lang="ts">
	import { toastError, toastSuccess } from '../lib/toast.svelte';

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
		onStatus,
		onUploaded,
	}: {
		projectId: string;
		currentFolderId: string | null;
		onStatus: (status: string) => void;
		onUploaded: (file: FileRow) => void;
	} = $props();

	// This panel is one row and stays one row. In-flight stage text goes up to
	// FileBrowser, which shows it on the meta row in place of the Available: figure —
	// rendering it here would grow the panel mid-upload and shove the file list down.
	// Kept to one short word each: it shares that row with the create icons, and a long
	// label would wrap the row in two, which is the same shift by another route.
	let uploading = $state(false);
	let dragging = $state(false);
	let selectedFile: File | null = $state(null);
	let fileInput: HTMLInputElement | undefined = $state();

	function openPicker() {
		if (uploading) return;
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
		if (uploading) return;
		dragging = true;
	}

	function handleDragLeave() {
		dragging = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (uploading) return;
		const file = e.dataTransfer?.files?.[0];
		if (file) selectedFile = file;
	}

	function handleFileInputChange() {
		if (uploading) return;
		selectedFile = fileInput?.files?.[0] ?? null;
	}

	function clearSelectedFile(e: MouseEvent) {
		e.stopPropagation();
		if (uploading) return;
		selectedFile = null;
		if (fileInput) fileInput.value = '';
	}

	// Upload stays clickable with nothing picked — saying why it can't run beats a
	// greyed-out button that gives no reason. onStatus carries only in-flight progress;
	// the outcome (either way) goes to a toast.
	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		const file = selectedFile;

		if (!file) {
			toastError('Choose a file to upload first.');
			return;
		}

		if (uploading) return;

		uploading = true;
		onStatus('Preparing…');

		const urlRes = await fetch(`/api/projects/${projectId}/files/upload-url`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: file.name, size: file.size }),
		});

		if (!urlRes.ok) {
			toastError(await urlRes.text());
			onStatus('');
			uploading = false;
			return;
		}

		const { uploadUrl, r2Key } = await urlRes.json() as { uploadUrl: string; r2Key: string };

		onStatus('Uploading…');

		const putRes = await fetch(uploadUrl, {
			method: 'PUT',
			body: file,
		});

		if (!putRes.ok) {
			toastError('Upload to R2 failed');
			onStatus('');
			uploading = false;
			return;
		}

		onStatus('Saving…');

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
			toastSuccess(`File ${created.filename} uploaded`);
			selectedFile = null;
			if (fileInput) fileInput.value = '';
		} else {
			const bodyText = await confirmRes.text();
			try {
				const result: { cleanedUp: boolean; error: string } = JSON.parse(bodyText);
				toastError(
					result.cleanedUp
						? `Upload failed (cleaned up): ${result.error}`
						: `Upload failed AND cleanup failed: ${result.error}`
				);
			} catch {
				toastError(bodyText);
			}
		}

		onStatus('');
		uploading = false;
	}
</script>

<div class="upload-form">
	<form onsubmit={handleSubmit}>
		<input type="file" bind:this={fileInput} onchange={handleFileInputChange} class="visually-hidden" tabindex="-1" disabled={uploading} />
		<div
			class="dropzone"
			class:dragging
			class:has-file={!!selectedFile}
			class:disabled={uploading}
			role="button"
			aria-disabled={uploading}
			tabindex={uploading ? -1 : 0}
			onclick={openPicker}
			onkeydown={handleKeydown}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			<span class="dropzone-text">{selectedFile ? selectedFile.name : 'Drag or Choose File'}</span>
			{#if selectedFile}
				<button type="button" class="clear-btn" aria-label="Remove selected file" onclick={clearSelectedFile} disabled={uploading}>×</button>
			{/if}
		</div>
		<button type="submit">{uploading ? 'Uploading…' : 'Upload'}</button>
	</form>
</div>

<style>
	/* Same shape as FileBrowser's .create-form so the dropzone + Upload button line up
	   exactly the way the New folder / New file panels' input + button do. */
	.upload-form form {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* Matches a text input exactly: same width, border and padding, and — the part that
	   isn't obvious — the same content height. An <input> keeps the UA's
	   `line-height: normal`, while this div inherits body's 1.6, which made the dropzone
	   several px taller than the New folder / New file inputs and dragged the whole row
	   out of line with them. */
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
		line-height: normal;
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

	.dropzone.disabled {
		cursor: default;
		opacity: 0.6;
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

	/* Matches FileBrowser's .create-form mobile block — global.css columns every form
	   below 640px, and this panel has to keep landing on the same two lines the New
	   folder / New file panels do (full-width control, button row under it). */
	@media (max-width: 640px) {
		.upload-form form {
			flex-direction: row;
		}

		.dropzone {
			flex: 1 1 100%;
			width: 100%;
		}

		.upload-form form button[type='submit'] {
			flex: 1 1 0;
		}
	}
</style>