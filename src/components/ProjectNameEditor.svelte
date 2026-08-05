<script lang="ts">
	const MAX_PROJECT_NAME_LENGTH = 200;

	let {
		projectId,
		initialName,
	}: {
		projectId: string;
		initialName: string;
	} = $props();

	let name = $state(initialName);
	let saving = $state(false);
	let error = $state<string | null>(null);

	let trimmed = $derived(name.trim());
	let unchanged = $derived(trimmed === initialName);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving || unchanged) return;

		if (!trimmed) {
			error = 'Project name is required';
			return;
		}

		if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
			error = `Project name: max ${MAX_PROJECT_NAME_LENGTH} characters`;
			return;
		}

		saving = true;
		error = null;

		const formData = new FormData();
		formData.set('name', trimmed);

		const res = await fetch(`/api/projects/${projectId}/rename`, {
			method: 'POST',
			body: formData,
		});

		if (!res.ok) {
			error = await res.text();
			saving = false;
			return;
		}

		// The project name is rendered by the server in the document title and sidebar,
		// so reload the page after the mutation to keep all copies in sync.
		window.location.reload();
	}
</script>

<form class="project-name-form" onsubmit={save}>
	<label class="field">
		<span>Project name</span>
		<input
			type="text"
			bind:value={name}
			maxlength={MAX_PROJECT_NAME_LENGTH}
			required
			disabled={saving}
		/>
	</label>

	{#if error}<p class="row-error">{error}</p>{/if}

	<div class="form-actions">
		<button type="submit" disabled={saving || !trimmed || unchanged}>
			{saving ? 'Saving...' : 'Save name'}
		</button>
	</div>
</form>

<style>
	.project-name-form {
		display: block;
		max-width: 420px;
		margin: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-bottom: var(--space-3);
	}

	.field span {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.field input {
		width: 100%;
		min-width: 0;
	}

	.form-actions {
		display: flex;
		gap: var(--space-3);
	}

	.row-error {
		color: var(--color-danger);
		margin: 0 0 var(--space-3);
	}
</style>
