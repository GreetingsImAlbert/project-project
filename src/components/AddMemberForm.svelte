<script lang="ts">
	import { slide } from 'svelte/transition';

	let {
		projectId,
		returnTo,
	}: {
		projectId: string;
		returnTo: string;
	} = $props();

	let open = $state(false);
	let submitting = $state(false);

	// Kept in component state (not just in the DOM) so a half-typed invite survives
	// closing the panel — same rule the Money page's add-row panels follow.
	let email = $state('');
	let role = $state('editor');
	let isAuditor = $state(false);

	let emailInput = $state<HTMLInputElement | null>(null);

	function openPanel() {
		open = true;
		// The input only exists once the panel has rendered.
		queueMicrotask(() => emailInput?.focus());
	}
</script>

<!-- A real form POST, not fetch: the endpoint answers with a redirect back to
     returnTo, which re-renders the sidebar with the new member in it. -->
<form
	method="POST"
	action={`/api/projects/${projectId}/members`}
	class="add-member"
	onsubmit={() => (submitting = true)}
>
	<input type="hidden" name="returnTo" value={returnTo} />

	{#if open}
		<div class="add-fields" transition:slide={{ duration: 150 }}>
			<input
				type="email"
				name="email"
				placeholder="User's email"
				required
				bind:value={email}
				bind:this={emailInput}
			/>
			<select name="role" bind:value={role}>
				<option value="editor">Editor</option>
				<option value="viewer">Viewer</option>
			</select>
			<label class="auditor-toggle">
				<input type="checkbox" name="isAuditor" bind:checked={isAuditor} />
				Auditor (can edit Money)
			</label>
		</div>
	{/if}

	<div class="add-actions">
		{#if open}
			<button type="submit" disabled={submitting}>{submitting ? 'Adding…' : 'Add member'}</button>
			<button type="button" class="btn-plain" onclick={() => (open = false)} disabled={submitting}>
				Cancel
			</button>
		{:else}
			<button type="button" onclick={openPanel}>Add member</button>
		{/if}
	</div>
</form>

<style>
	/* Folded away by default so the member list, not the form, owns the sidebar's
	   vertical space — same 'Add …' toggle shape as the Money page panels: the
	   fields slide open above an actions row whose Add button never moves or
	   changes size, with Cancel appearing beside it only while open. */
	.add-member {
		display: block;
		margin: var(--space-3) 0 var(--space-4);
	}

	.add-fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-bottom: var(--space-2);
	}

	.add-actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}

	.auditor-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: 0.8rem;
	}

	.auditor-toggle input {
		width: auto;
		flex: 0 0 auto;
	}
</style>
