<script lang="ts">
	import { fly } from 'svelte/transition';
	import { toastState, dismissToast } from '../lib/toast.svelte';
</script>

<!-- Fixed to the viewport, not the island, so a notice raised from a control that has
     scrolled out of view is still seen. -->
<div class="toast-stack" role="status" aria-live="polite">
	{#each toastState.toasts as toast (toast.id)}
		<!-- class: directives rather than an interpolated name — Svelte's scoped-CSS pass
		     can't match a class it only sees as an expression, and prunes the rule. -->
		<div
			class="toast"
			class:toast-error={toast.kind === 'error'}
			class:toast-success={toast.kind === 'success'}
			transition:fly={{ x: 16, duration: 150 }}
		>
			<span class="toast-message">{toast.message}</span>
			<button type="button" class="toast-close" aria-label="Dismiss" onclick={() => dismissToast(toast.id)}>×</button>
		</div>
	{/each}
</div>

<style>
	.toast-stack {
		position: fixed;
		top: var(--space-4);
		right: var(--space-4);
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: min(340px, calc(100vw - var(--space-4) * 2));
		/* The stack spans the full column even when empty; only the notices themselves
		   should ever intercept a click. */
		pointer-events: none;
	}

	/* Solid fill, same reasoning as .btn-danger in global.css: the outlined version was a
	   saturated hairline around a page-coloured middle, which reads as a shimmer rather
	   than a block. The kind classes set the fill; the label rides on --color-bg. */
	.toast {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		background: var(--color-fg);
		color: var(--color-bg);
		border: 1px solid transparent;
		padding: var(--space-2) var(--space-3);
		font-size: 0.85rem;
		line-height: 1.4;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
	}

	.toast-error {
		background: var(--color-danger);
		border-color: var(--color-danger);
	}

	.toast-success {
		background: var(--color-success);
		border-color: var(--color-success);
	}

	.toast-message {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.toast-close {
		flex: 0 0 auto;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font-size: 1rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.toast-close:hover {
		opacity: 0.7;
	}
</style>
