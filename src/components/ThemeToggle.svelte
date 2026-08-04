<script lang="ts">
	type Theme = 'light' | 'dim' | 'dark';

	function readTheme(): Theme {
		if (typeof document !== 'undefined') {
			const current = document.documentElement.dataset.theme;
			if (current === 'dark' || current === 'dim') return current;
		}

		if (typeof localStorage !== 'undefined') {
			const stored = localStorage.getItem('p2-theme');
			if (stored === 'dark' || stored === 'dim') return stored;
		}

		return 'light';
	}

	let theme = $state<Theme>(readTheme());

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

</script>

<div class="theme-toggle">
	<button type="button" class="btn-plain" class:active={theme === 'light'} onclick={() => apply('light')}>Light</button>
	<button type="button" class="btn-plain" class:active={theme === 'dark'} onclick={() => apply('dark')}>Dark</button>
	<button type="button" class="btn-plain" class:active={theme === 'dim'} onclick={() => apply('dim')}>Dim</button>
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

	/* The server cannot read localStorage, so its fresh navigation markup initially marks
	   Light active. The inline theme bootstrap has already set data-theme by this point;
	   use that root state to prevent a wrong active button before Svelte hydrates. */
	:global(html[data-theme='dark']) .theme-toggle button.active,
	:global(html[data-theme='dim']) .theme-toggle button.active {
		background: transparent;
		color: var(--color-fg);
	}

	:global(html[data-theme='dark']) .theme-toggle button:nth-child(2),
	:global(html[data-theme='dim']) .theme-toggle button:nth-child(3) {
		background: var(--color-fg);
		color: var(--color-bg);
	}
</style>
