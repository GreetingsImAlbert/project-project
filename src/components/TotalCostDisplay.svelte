<script lang="ts">
	import { formatCurrency, initCurrency, type CurrencyCode } from '../lib/currency.svelte';

	let { totalCost, currency }: { totalCost: number; currency: CurrencyCode } = $props();

	initCurrency(currency);
</script>

<p>Total projected cost: <strong>{formatCurrency(totalCost)}</strong></p>
