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

	function startEdit() {
		draft = description ?? '';
		error = null;
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
	<h2>Overview</h2>
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
	<p class="muted">{description || 'No description yet.'}</p>
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
