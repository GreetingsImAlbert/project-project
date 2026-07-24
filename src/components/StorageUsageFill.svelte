<script lang="ts">
	import { onMount } from 'svelte';
	import { formatBytes } from '../lib/format-bytes';
	import { storageUsageState, initStorageUsage } from '../lib/storage-usage.svelte';

	interface Props {
		initialUsedBytes: number;
		capBytes: number;
	}

	const { initialUsedBytes, capBytes }: Props = $props();

	onMount(() => {
		initStorageUsage(initialUsedBytes);
	});

	const percentUsed = $derived(capBytes > 0 ? Math.min(100, (storageUsageState.usedBytes / capBytes) * 100) : 0);
	const nearLimit = $derived(percentUsed >= 90);
</script>

<div class="storage-usage-stats">
	{formatBytes(storageUsageState.usedBytes)} of {formatBytes(capBytes)} ({percentUsed.toFixed(1)}%)
</div>
<div class="storage-usage-track">
	<div class="storage-usage-fill" class:near-limit={nearLimit} style={`width: ${percentUsed}%`}></div>
</div>

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
</style>
