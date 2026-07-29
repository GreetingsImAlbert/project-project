<script lang="ts">
	import { slide } from 'svelte/transition';

	let { projectId }: { projectId: string } = $props();

	let open = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	let displayName = $state('');
	let note = $state('');

	let nameInput = $state<HTMLInputElement | null>(null);

	function openPanel() {
		open = true;
		error = null;
		queueMicrotask(() => nameInput?.focus());
	}

	function cancel() {
		open = false;
		error = null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();

		error = null;
		submitting = true;

		const formData = new FormData();
		formData.set('displayName', displayName);
		formData.set('note', note);

		const res = await fetch(`/api/projects/${projectId}/ghost-members/create`, { method: 'POST', body: formData });

		if (!res.ok) {
			error = await res.text();
			submitting = false;
			return;
		}

		// The sidebar's ghost member list is rendered server-side, so a fresh load is
		// the simplest way to show the new ghost everywhere it's referenced.
		window.location.reload();
	}
</script>

<form class="add-ghost" onsubmit={submit}>
	{#if open}
		<div class="add-fields" transition:slide={{ duration: 150 }}>
			<p class="muted ghost-hint">
				A ghost member stands in for somebody funding or buying for this project who has no P2
				account — a commissioner, a sponsor, an outside supplier. They take a share of the split
				and can be named on transactions, but they never sign in.
			</p>
			<input
				type="text"
				placeholder="e.g. Dept. of Engineering"
				required
				maxlength="80"
				bind:value={displayName}
				bind:this={nameInput}
			/>
			<input type="text" placeholder="Who they are (optional)" maxlength="200" bind:value={note} />
			{#if error}<p class="panel-error">{error}</p>{/if}
		</div>
	{/if}

	<div class="add-actions">
		{#if open}
			<button type="submit" disabled={submitting}>{submitting ? 'Adding…' : 'Add ghost member'}</button>
			<button type="button" class="btn-plain" onclick={cancel} disabled={submitting}>Cancel</button>
		{:else}
			<button type="button" onclick={openPanel}>Add ghost member</button>
		{/if}
	</div>
</form>

<style>
	.add-ghost {
		display: block;
		margin: var(--space-3) 0 var(--space-4);
	}

	.add-fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-bottom: var(--space-2);
	}

	.ghost-hint {
		font-size: 0.75rem;
		margin: 0;
	}

	.add-actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
</style>
