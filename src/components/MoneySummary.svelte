<script lang="ts">
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import { bomState, initBom, type BomItem } from '../lib/bom-store.svelte';
	import { transactionsState, initTransactions, type Transaction } from '../lib/transactions-store.svelte';
	import { contributionsState, initContributions } from '../lib/contributions-store.svelte';
	import { netSpend, paidByMember } from '../lib/money-math';

	let {
		currentUserId,
		initialItems,
		initialTransactions,
		initialPercents,
	}: {
		currentUserId: string;
		initialItems: BomItem[];
		initialTransactions: Transaction[];
		initialPercents: Record<string, number>;
	} = $props();

	// Every island on the page seeds the same three stores, so whichever renders
	// first wins and the rest are no-ops — see initTransactions for why.
	initBom(initialItems);
	initTransactions(initialTransactions);
	initContributions(initialPercents);

	let bomTotal = $derived(bomState.items.reduce((sum, item) => sum + (item.total_cost ?? 0), 0));
	let netTotal = $derived(netSpend(transactionsState.items));

	let sharePercent = $derived(contributionsState.percents[currentUserId] ?? 0);
	let shareAmount = $derived((netTotal * sharePercent) / 100);
	let dues = $derived(shareAmount - paidByMember(transactionsState.items, currentUserId));

	// Rounded before comparing so a floating-point crumb doesn't render as "You owe"
	// alongside a displayed balance of exactly zero.
	let duesRounded = $derived(Math.round(dues * 100) / 100);

	let duesLabel = $derived(duesRounded > 0 ? 'You owe' : duesRounded < 0 ? "You're owed" : 'Settled up');

	onMount(() => {
		initCurrency();
	});
</script>

<div class="summary">
	<div class="tile">
		<span class="tile-label">Net spent</span>
		<span class="tile-value">{formatCurrency(netTotal)}</span>
		<span class="tile-note">across {transactionsState.items.length} transaction{transactionsState.items.length === 1 ? '' : 's'}</span>
	</div>

	<div class="tile">
		<span class="tile-label">BOM total</span>
		<span class="tile-value">{formatCurrency(bomTotal)}</span>
		<span class="tile-note">{bomState.items.length} item{bomState.items.length === 1 ? '' : 's'} planned</span>
	</div>

	<div class="tile">
		<span class="tile-label">Your share</span>
		<span class="tile-value">{formatCurrency(shareAmount)}</span>
		<span class="tile-note">{sharePercent.toFixed(2)}% of net spend</span>
	</div>

	<div class="tile" class:owed={duesRounded > 0} class:credit={duesRounded < 0}>
		<span class="tile-label">{duesLabel}</span>
		<span class="tile-value">{formatCurrency(Math.abs(duesRounded))}</span>
		<span class="tile-note">
			{#if duesRounded > 0}
				to settle with the group
			{:else if duesRounded < 0}
				back from the group
			{:else}
				nothing outstanding
			{/if}
		</span>
	</div>
</div>

<style>
	.summary {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0;
		border: 1px solid var(--color-border-strong);
		margin-bottom: var(--space-2);
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: var(--space-3);
		border-right: 1px solid var(--color-border);
	}

	.tile:last-child {
		border-right: none;
	}

	.tile-label {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tile-value {
		font-size: 1.15rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tile-note {
		color: var(--color-muted);
		font-size: 0.7rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tile.owed .tile-value,
	.tile.owed .tile-label {
		color: var(--color-danger);
	}

	.tile.credit .tile-value,
	.tile.credit .tile-label {
		color: var(--color-role-viewer);
	}

	@media (max-width: 900px) {
		.summary {
			grid-template-columns: repeat(2, 1fr);
		}

		.tile:nth-child(2n) {
			border-right: none;
		}

		.tile:nth-child(n + 3) {
			border-top: 1px solid var(--color-border);
		}
	}

	@media (max-width: 480px) {
		.summary {
			grid-template-columns: 1fr;
		}

		.tile {
			border-right: none;
		}

		.tile:not(:first-child) {
			border-top: 1px solid var(--color-border);
		}
	}
</style>
