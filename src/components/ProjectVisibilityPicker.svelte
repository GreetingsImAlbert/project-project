<script lang="ts">
	import { onSwapOrDestroy } from '../lib/island-teardown';

	let {
		projectId,
		isPublic,
	}: {
		projectId: string;
		isPublic: boolean;
	} = $props();

	let value = $state(isPublic);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<string | null>(null);
	let savedTimer: ReturnType<typeof setTimeout> | undefined;

	function setValue(next: boolean) {
		value = next;
		saving = false;
		saved = false;
		error = null;
	}

	async function setVisibility(next: boolean) {
		if (next === value || saving) return;
		const previous = value;
		setValue(next);
		saving = true;

		try {
			const res = await fetch(`/api/projects/${projectId}/visibility`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ isPublic: next }),
			});
			if (!res.ok) {
				error = await res.text();
				setValue(previous);
				return;
			}
			clearTimeout(savedTimer);
			saved = true;
			savedTimer = setTimeout(() => {
				saved = false;
			}, 2500);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save visibility';
			setValue(previous);
		} finally {
			saving = false;
		}
	}

	onSwapOrDestroy(() => {
		clearTimeout(savedTimer);
	});
</script>

<div class="visibility-picker">
	<div class="visibility-options" role="group" aria-label="Project visibility">
		<button
			type="button"
			class:active={value === true}
			disabled={saving}
			onclick={() => setVisibility(true)}
		>
			Public
		</button>
		<button
			type="button"
			class:active={value === false}
			disabled={saving}
			onclick={() => setVisibility(false)}
		>
			Private
		</button>
	</div>
	<p class="visibility-hint muted">
		Public projects show their name and description to anyone, even without an account.
		Everything else stays member-only.
	</p>
	{#if saving}
		<p class="visibility-status muted" role="status">Saving…</p>
	{:else if saved}
		<p class="visibility-status muted" role="status">Saved</p>
	{/if}
	{#if error}<p class="row-error">{error}</p>{/if}
</div>

<style>
	.visibility-picker {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.visibility-options {
		display: flex;
		gap: var(--space-1);
	}

	.visibility-options button {
		padding: var(--space-1) var(--space-4);
		font-size: 0.85rem;
	}

	.visibility-options button.active {
		background: var(--color-highlight-strong);
	}

	.visibility-hint {
		font-size: 0.8rem;
		margin: 0;
	}

	.visibility-status {
		font-size: 0.75rem;
		margin: 0;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
