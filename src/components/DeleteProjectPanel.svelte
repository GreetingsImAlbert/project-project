<script lang="ts">
	let {
		projectId,
		projectName,
	}: {
		projectId: string;
		projectName: string;
	} = $props();

	let confirmText = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Typing the exact project name is a much higher bar than a plain confirm()
	// dialog — appropriate here since this is the only irreversible, whole-project
	// action in the app (everything else deletes one row).
	const canDelete = $derived(confirmText === projectName);

	async function deleteProject() {
		if (!canDelete) return;
		busy = true;
		error = null;

		const res = await fetch(`/api/projects/${projectId}/delete`, { method: 'POST' });

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		window.location.href = '/projects';
	}
</script>

<div class="delete-panel">
	<p>
		Deleting this project permanently removes its tasks, files, BOM items, transactions, and
		members. This cannot be undone.
	</p>
	<p>
		Before deleting, <a class="download-link" href={`/api/projects/${projectId}/download-all`}>download this project</a>
		to keep a copy of its data and files.
	</p>

	<label class="field">
		<span>Type <strong>{projectName}</strong> to confirm</span>
		<input type="text" bind:value={confirmText} placeholder={projectName} disabled={busy} />
	</label>

	{#if error}<p class="row-error">{error}</p>{/if}

	<button type="button" class="btn-danger" disabled={!canDelete || busy} onclick={deleteProject}>
		{busy ? 'Deleting…' : 'Delete this project'}
	</button>
</div>

<style>
	.delete-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		max-width: 32rem;
		border: 1px solid var(--color-danger);
		padding: var(--space-4);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}

	.download-link {
		text-decoration: underline;
		text-underline-offset: 0.15em;
	}
</style>
