<script lang="ts">
	import { onMount } from 'svelte';
	import { formatBytes } from '../lib/format-bytes';
	import { storageUsageState, initStorageUsage } from '../lib/storage-usage.svelte';

	interface Props {
		initialUsedBytes: number;
		capBytes: number;
		initialFailed?: boolean;
	}

	const { initialUsedBytes, capBytes, initialFailed = false }: Props = $props();

	onMount(() => {
		initStorageUsage(initialUsedBytes, initialFailed);
	});

	const percentUsed = $derived(capBytes > 0 ? Math.min(100, (storageUsageState.usedBytes / capBytes) * 100) : 0);
	const nearLimit = $derived(percentUsed >= 90);
</script>

{#if storageUsageState.failed}
	<div class="storage-usage-stats storage-usage-error">
		Storage usage unavailable
		<button type="button" class="reload-btn" onclick={() => location.reload()}>⟳ Reload</button>
	</div>
{:else}
	<div class="storage-usage-stats">
		{formatBytes(storageUsageState.usedBytes)} of {formatBytes(capBytes)} ({percentUsed.toFixed(1)}%)
	</div>
	<div class="storage-usage-track">
		<div class="storage-usage-fill" class:near-limit={nearLimit} style={`width: ${percentUsed}%`}></div>
	</div>
{/if}

<style>
	.storage-usage-stats {
		font-size: 0.85rem;
		color: var(--color-muted);
		margin-bottom: var(--space-1);
		text-align: right;
	}

	.storage-usage-track {
		height: 8px;
		background: var(--color-border);
		overflow: hidden;
	}

	.storage-usage-fill {
		height: 100%;
		background: var(--color-fg);
	}

	.storage-usage-fill.near-limit {
		background: var(--color-danger);
	}

	.storage-usage-error {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		color: var(--color-danger);
	}

	.reload-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--color-danger);
		text-decoration: underline;
		cursor: pointer;
		font-size: inherit;
	}
</style>
