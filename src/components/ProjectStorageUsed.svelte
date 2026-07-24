<script lang="ts">
	import { onMount } from 'svelte';
	import { formatBytes } from '../lib/format-bytes';
	import { projectStorageState, initProjectStorage } from '../lib/project-storage.svelte';

	interface Props {
		initialUsedBytes: number;
	}

	const { initialUsedBytes }: Props = $props();

	onMount(() => {
		initProjectStorage(initialUsedBytes);
	});
</script>

<p class="project-storage-total">Project storage used: {formatBytes(projectStorageState.usedBytes)}</p>

<style>
	.project-storage-total {
		font-size: 0.85rem;
		color: var(--color-muted);
	}
</style>
