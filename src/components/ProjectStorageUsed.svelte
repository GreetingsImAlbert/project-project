<script lang="ts">
	import { onMount } from 'svelte';
	import { formatBytes } from '../lib/format-bytes';
	import { projectStorageState, initProjectStorage } from '../lib/project-storage.svelte';

	interface Props {
		initialUsedBytes: number;
		initialFailed?: boolean;
	}

	const { initialUsedBytes, initialFailed = false }: Props = $props();

	onMount(() => {
		initProjectStorage(initialUsedBytes, initialFailed);
	});
</script>

{#if projectStorageState.failed}
	<p class="project-storage-total project-storage-error">
		Project storage used: unavailable
		<button type="button" class="reload-btn" onclick={() => location.reload()}>⟳ Reload</button>
	</p>
{:else}
	<p class="project-storage-total">Project storage used: {formatBytes(projectStorageState.usedBytes)}</p>
{/if}

<style>
	.project-storage-total {
		font-size: 0.85rem;
		color: var(--color-muted);
	}

	.project-storage-error {
		color: var(--color-danger);
	}

	.reload-btn {
		background: none;
		border: none;
		padding: 0;
		margin-left: var(--space-1);
		color: var(--color-danger);
		text-decoration: underline;
		cursor: pointer;
		font-size: inherit;
	}
</style>
