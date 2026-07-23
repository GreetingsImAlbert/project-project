<script lang="ts">
	import { onMount } from 'svelte';
	import { CURRENCIES, type CurrencyCode, currencyState, setCurrency, initCurrency } from '../lib/currency.svelte';

	onMount(() => {
		initCurrency();
	});
</script>

<select class="currency-picker" value={currencyState.code} onchange={(e) => setCurrency(e.currentTarget.value as CurrencyCode)}>
	{#each CURRENCIES as code (code)}
		<option value={code}>{code}</option>
	{/each}
</select>

<style>
	.currency-picker {
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
	}
</style>
