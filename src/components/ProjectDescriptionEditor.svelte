<script lang="ts">
	let {
		projectId,
		initialDescription,
		canEdit,
	}: {
		projectId: string;
		initialDescription: string | null;
		canEdit: boolean;
	} = $props();

	let description = $state(initialDescription);
	let editing = $state(false);
	let draft = $state(initialDescription ?? '');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let expanded = $state(false);
	let canExpand = $state(false);

	function measureOverflow(node: HTMLElement) {
		const update = () => {
			if (!expanded) canExpand = node.scrollHeight > node.clientHeight + 1;
		};

		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return {
			destroy() {
				observer.disconnect();
			},
		};
	}

	function startEdit() {
		draft = description ?? '';
		error = null;
		expanded = false;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		error = null;
	}

	async function save() {
		saving = true;
		error = null;

		const formData = new FormData();
		formData.set('description', draft);

		const res = await fetch(`/api/projects/${projectId}/update-description`, {
			method: 'POST',
			body: formData,
		});

		if (!res.ok) {
			error = await res.text();
			saving = false;
			return;
		}

		const updated: { description: string | null } = await res.json();
		description = updated.description;
		editing = false;
		saving = false;
	}
</script>

<div class="overview-heading">
	<h2>Description</h2>
	{#if canEdit && !editing}
		<button type="button" class="edit-icon" aria-label="Edit description" onclick={startEdit}>✎</button>
	{/if}
</div>

{#if editing}
	<div class="description-editor">
		<textarea bind:value={draft} rows="4" maxlength="2000" placeholder="Add a project description…"></textarea>
		{#if error}<p class="row-error">{error}</p>{/if}
		<div class="editor-actions">
			<button type="button" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
			<button type="button" class="btn-plain" onclick={cancelEdit} disabled={saving}>Cancel</button>
		</div>
	</div>
{:else}
	<p class="muted description-text" class:expanded use:measureOverflow>{description || 'No description yet.'}</p>
	{#if description && canExpand}
		<button
			type="button"
			class="description-toggle"
			class:expanded
			aria-label={expanded ? 'Collapse description' : 'Expand description'}
			aria-expanded={expanded}
			title={expanded ? 'Collapse description' : 'Expand description'}
			onclick={() => (expanded = !expanded)}
		>
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="m6 9 6 6 6-6" />
			</svg>
		</button>
	{/if}
{/if}

<style>
	.overview-heading {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.overview-heading h2 {
		margin: 0;
		padding-top: 0;
		border-top: none;
	}

	.edit-icon {
		flex: 0 0 auto;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-fg);
		font-size: 1rem;
		line-height: 1.3;
		cursor: pointer;
	}

	.edit-icon:hover {
		opacity: 0.6;
	}

	.description-text {
		white-space: pre-wrap;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		overflow: hidden;
	}

	.description-text.expanded {
		display: block;
		overflow: visible;
	}

	.description-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		margin: calc(-1 * var(--space-2)) auto 0;
		padding: var(--space-1) var(--space-2);
		color: var(--color-muted);
		background: transparent;
		border: none;
	}

	.description-toggle svg {
		transition: transform 0.15s ease;
	}

	.description-toggle.expanded svg {
		transform: rotate(180deg);
	}

	.description-editor textarea {
		width: 100%;
		min-width: 0;
	}

	.editor-actions {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.row-error {
		color: var(--color-danger);
		margin: var(--space-2) 0 0;
	}
</style>
