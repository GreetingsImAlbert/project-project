<script lang="ts">
	import { onMount } from 'svelte';

	type Theme = 'light' | 'dim' | 'dark';

	let theme = $state<Theme>('light');

	function apply(t: Theme) {
		theme = t;
		if (t === 'light') {
			delete document.documentElement.dataset.theme;
			localStorage.removeItem('p2-theme');
		} else {
			document.documentElement.dataset.theme = t;
			localStorage.setItem('p2-theme', t);
		}
	}

	onMount(() => {
		const stored = localStorage.getItem('p2-theme');
		if (stored === 'dark' || stored === 'dim') theme = stored;
	});
</script>

<div class="theme-toggle">
	<button type="button" class="btn-plain" class:active={theme === 'light'} onclick={() => apply('light')}>Light</button>
	<button type="button" class="btn-plain" class:active={theme === 'dim'} onclick={() => apply('dim')}>Dim</button>
	<button type="button" class="btn-plain" class:active={theme === 'dark'} onclick={() => apply('dark')}>Dark</button>
</div>

<style>
	.theme-toggle {
		display: flex;
		gap: var(--space-2);
	}

	.theme-toggle button {
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
	}

	.theme-toggle button.active {
		background: var(--color-fg);
		color: var(--color-bg);
	}
</style>
