<script lang="ts">
	let { ownedProjectCount, displayName }: { ownedProjectCount: number; displayName: string } = $props();

	let password = $state('');
	let confirmText = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	// "DELETE" rather than the project-name pattern DeleteProjectPanel uses —
	// there's no per-account name to type, and the word itself is a high enough
	// bar for the only action here that deletes the account itself.
	const canDelete = $derived(confirmText === 'DELETE' && password.length > 0 && ownedProjectCount === 0);

	async function deleteAccount() {
		if (!canDelete) return;
		busy = true;
		error = null;

		const formData = new FormData();
		formData.set('password', password);

		const res = await fetch('/api/account/delete', { method: 'POST', body: formData });

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		window.location.href = '/login';
	}
</script>

<div class="delete-panel">
	{#if ownedProjectCount > 0}
		<p class="form-note error">
			You still own {ownedProjectCount} project{ownedProjectCount === 1 ? '' : 's'}. Transfer ownership or delete
			{ownedProjectCount === 1 ? 'it' : 'them'} before deleting your account.
		</p>
	{/if}

	<p>
		Deleting your account signs you out everywhere and gives you 10 days to change your mind — log back in during
		that window to cancel. After that it's permanent: your account is gone for good.
	</p>
	<ul>
		<li>Files you've uploaded stay in their projects for 30 more days after that, so other members can save a copy, then they're deleted.</li>
		<li>Your transaction history stays on the Money page, attributed to "{displayName} [deleted]" instead of your profile.</li>
	</ul>

	<label class="field">
		<span>Password</span>
		<input type="password" bind:value={password} autocomplete="current-password" disabled={busy} />
	</label>

	<label class="field">
		<span>Type <strong>DELETE</strong> to confirm</span>
		<input type="text" bind:value={confirmText} placeholder="DELETE" disabled={busy} />
	</label>

	{#if error}<p class="form-note error">{error}</p>{/if}

	<button type="button" class="btn-danger" disabled={!canDelete || busy} onclick={deleteAccount}>
		{busy ? 'Scheduling deletion…' : 'Delete my account'}
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

	.delete-panel ul {
		margin: 0;
		padding-left: var(--space-5, 1.25rem);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
</style>
