<script lang="ts">
	import { onMount } from 'svelte';
	import { MOBILE_SIDEBAR_EVENT, mobileSidebarIsOpen, setMobileSidebarOpen } from '../lib/sidebar-state';

	let open = $state(false);

	onMount(() => {
		open = mobileSidebarIsOpen();

		function handleSidebarChange(event: Event) {
			const detail = (event as CustomEvent<{ open?: boolean }>).detail;
			open = detail?.open ?? mobileSidebarIsOpen();
		}

		window.addEventListener(MOBILE_SIDEBAR_EVENT, handleSidebarChange);
		return () => window.removeEventListener(MOBILE_SIDEBAR_EVENT, handleSidebarChange);
	});

	function toggle() {
		setMobileSidebarOpen(!open);
	}
</script>

<button
	type="button"
	class="mobile-sidebar-toggle"
	aria-label={open ? 'Close navigation' : 'Open navigation'}
	aria-controls="app-sidebar"
	aria-expanded={open}
	title={open ? 'Close navigation' : 'Open navigation'}
	onclick={toggle}
>
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M3 6h18M3 12h18M3 18h18" />
	</svg>
</button>

<style>
	.mobile-sidebar-toggle {
		display: none;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2rem;
		height: 2rem;
		padding: 0;
		background: transparent;
		border: 0;
		color: var(--color-fg);
		cursor: pointer;
	}

	.mobile-sidebar-toggle:hover {
		background: var(--color-highlight);
		border-radius: var(--radius-sm);
	}

	.mobile-sidebar-toggle svg {
		width: 1.25rem;
		height: 1.25rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
	}

	@media (max-width: 768px) {
		.mobile-sidebar-toggle {
			display: inline-flex;
		}
	}
</style>
