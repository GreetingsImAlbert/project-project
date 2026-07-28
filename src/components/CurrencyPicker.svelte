<script lang="ts">
	import { CURRENCIES, type CurrencyCode, setCurrency } from '../lib/currency.svelte';

	let {
		projectId,
		currency,
	}: {
		projectId: string;
		currency: CurrencyCode;
	} = $props();

	let selected = $state(currency);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function save(code: CurrencyCode) {
		selected = code;
		busy = true;
		error = null;

		const body = new URLSearchParams();
		body.set('currency', code);

		const res = await fetch(`/api/projects/${projectId}/currency`, {
			method: 'POST',
			body,
		});

		if (!res.ok) {
			error = await res.text();
			selected = currency;
			busy = false;
			return;
		}

		// Applies immediately to every currency-formatted figure already on the
		// page (BOM totals, dues, transactions) — not just this picker.
		setCurrency(code);
		busy = false;
	}
</script>

<div class="currency-picker">
	<select
		value={selected}
		disabled={busy}
		onchange={(e) => save(e.currentTarget.value as CurrencyCode)}
	>
		{#each CURRENCIES as code (code)}
			<option value={code}>{code}</option>
		{/each}
	</select>
	{#if error}<p class="row-error">{error}</p>{/if}
</div>

<style>
	.currency-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		align-items: flex-start;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
