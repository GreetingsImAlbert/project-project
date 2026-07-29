<script lang="ts">
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function cancelDeletion() {
		busy = true;
		error = null;

		const res = await fetch('/api/account/cancel-deletion', { method: 'POST' });

		if (!res.ok) {
			error = await res.text();
			busy = false;
			return;
		}

		window.location.href = '/account';
	}
</script>

{#if error}<p class="form-note error">{error}</p>{/if}

<button type="button" disabled={busy} onclick={cancelDeletion}>
	{busy ? 'Cancelling…' : 'Cancel deletion, keep my account'}
</button>
