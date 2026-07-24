<script lang="ts">
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';

	let { totalCost }: { totalCost: number } = $props();

	onMount(() => {
		initCurrency();
	});
</script>

<p>Total projected cost: <strong>{formatCurrency(totalCost)}</strong></p>
