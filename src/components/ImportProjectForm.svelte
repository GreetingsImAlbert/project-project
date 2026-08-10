<script lang="ts">
	import { toastError, toastSuccess } from '../lib/toast.svelte';

	let importing = $state(false);
	let status = $state('');
	let fileInput: HTMLInputElement | undefined = $state();
	let pendingFileKey = $state('');
	let importToken = $state('');

	function openPicker() {
		if (!importing) fileInput?.click();
	}

	function resetInput() {
		if (fileInput) fileInput.value = '';
	}

	async function handleFileChange() {
		const file = fileInput?.files?.[0];
		if (!file || importing) return;

		if (!file.name.toLowerCase().endsWith('.zip')) {
			toastError('Choose a P2 project ZIP file.');
			resetInput();
			return;
		}
		const fileKey = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
		if (fileKey !== pendingFileKey || !importToken) {
			pendingFileKey = fileKey;
			importToken = crypto.randomUUID();
		}

		importing = true;
		status = 'Preparing import…';
		const body = new FormData();
		body.set('file', file, file.name);
		body.set('importToken', importToken);

		try {
			status = 'Uploading project…';
			const response = await fetch('/api/projects/import', { method: 'POST', body });
			const responseText = await response.text();
			let result: { projectId?: string; name?: string; message?: string } = {};
			try {
				result = JSON.parse(responseText) as typeof result;
			} catch {
				// Plain-text API errors remain valid for the shared toast contract.
			}

			if (!response.ok) {
				toastError((result.message ?? responseText) || 'Project import failed.');
				return;
			}

			toastSuccess(result.message ?? `${result.name ?? 'Project'} imported successfully.`);
			importToken = '';
			pendingFileKey = '';
		} catch (error) {
			toastError(error instanceof Error ? error.message : 'Project import failed.');
		} finally {
			importing = false;
			status = '';
			resetInput();
		}
	}
</script>

<div class="import-project-form">
	<input
		type="file"
		bind:this={fileInput}
		accept=".zip,application/zip"
		onchange={handleFileChange}
		class="visually-hidden"
		tabindex="-1"
		disabled={importing}
	/>
	<button type="button" class="btn-plain" onclick={openPicker} disabled={importing}>
		{importing ? 'Importing…' : 'Choose project ZIP'}
	</button>
	{#if status}<span class="import-status" role="status">{status}</span>{/if}
</div>

<style>
	.import-project-form {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.import-status {
		color: var(--color-muted);
		font-size: 0.85rem;
	}
</style>
