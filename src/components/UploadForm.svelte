<script lang="ts">
	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		profiles: { display_name: string } | null;
	}

	let {
		projectId,
		currentFolderId,
		onUploaded,
	}: {
		projectId: string;
		currentFolderId: string | null;
		onUploaded: (file: FileRow) => void;
	} = $props();

	let status = $state('');
	let uploading = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		const file = fileInput?.files?.[0];
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

<h2>Upload a file</h2>
<form onsubmit={handleSubmit}>
	<input type="file" bind:this={fileInput} required />
	<button type="submit" disabled={uploading}>Upload</button>
</form>
{#if status}<p class="muted">{status}</p>{/if}