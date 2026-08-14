<script lang="ts">
	interface TransferCandidate {
		user_id: string;
		display_name: string;
	}

	let {
		projectId,
		projectName,
		members,
	}: {
		projectId: string;
		projectName: string;
		members: TransferCandidate[];
	} = $props();

	let newOwnerId = $state('');
	let confirmText = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const canTransfer = $derived(Boolean(newOwnerId) && confirmText === projectName);

	async function transferOwnership() {
		if (!canTransfer) return;
		busy = true;
		error = null;

		const body = new FormData();
		body.set('newOwnerId', newOwnerId);

		try {
			const response = await fetch(`/api/projects/${projectId}/transfer-ownership`, { method: 'POST', body });
			if (!response.ok) {
				error = await response.text();
				return;
			}

			// This user becomes an editor and can no longer open owner-only Settings.
			window.location.href = `/projects/${projectId}`;
		} catch {
			error = 'Could not transfer ownership';
		} finally {
			busy = false;
		}
	}
</script>

<div class="transfer-panel">
	<h4>Transfer ownership</h4>
	<p>
		Give another member full control of this project. You will become an editor and will no longer
		be able to access project settings.
	</p>

	{#if members.length > 0}
		<label class="field">
			<span>New owner</span>
			<select bind:value={newOwnerId} disabled={busy}>
				<option value="">Choose a member</option>
				{#each members as member (member.user_id)}
					<option value={member.user_id}>{member.display_name}</option>
				{/each}
			</select>
		</label>

		<label class="field">
			<span>Type <strong>{projectName}</strong> to confirm</span>
			<input type="text" bind:value={confirmText} placeholder={projectName} disabled={busy} />
		</label>
	{:else}
		<p class="muted">Add another member before transferring ownership.</p>
	{/if}

	{#if error}<p class="row-error">{error}</p>{/if}

	<button type="button" class="btn-danger" disabled={!canTransfer || busy} onclick={transferOwnership}>
		{busy ? 'Transferring…' : 'Transfer ownership'}
	</button>
</div>

<style>
	.transfer-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		max-width: 32rem;
		border: 1px solid var(--color-danger);
		padding: var(--space-4);
	}

	h4,
	p {
		margin: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.row-error {
		color: var(--color-danger);
	}
</style>
