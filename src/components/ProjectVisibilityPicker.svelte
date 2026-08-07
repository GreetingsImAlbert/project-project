<script lang="ts">
	import { onSwapOrDestroy } from '../lib/island-teardown';

	let {
		projectId,
		isPublic,
		publicFilesEnabled,
	}: {
		projectId: string;
		isPublic: boolean;
		publicFilesEnabled: boolean;
	} = $props();

	type VisibilityScope = 'project' | 'files';

	let projectValue = $state(isPublic);
	let filesValue = $state(publicFilesEnabled);
	let saving = $state<VisibilityScope | null>(null);
	let saved = $state<VisibilityScope | null>(null);
	let error = $state<{ scope: VisibilityScope; message: string } | null>(null);
	let savedTimers: Partial<Record<VisibilityScope, ReturnType<typeof setTimeout>>> = {};

	function setValue(scope: VisibilityScope, next: boolean) {
		if (scope === 'project') projectValue = next;
		else filesValue = next;
		saved = null;
		error = null;
	}

	function restoreValue(scope: VisibilityScope, previous: boolean) {
		if (scope === 'project') projectValue = previous;
		else filesValue = previous;
	}

	async function setVisibility(scope: VisibilityScope, next: boolean) {
		const current = scope === 'project' ? projectValue : filesValue;
		if (next === current || saving) return;
		const previous = current;
		setValue(scope, next);
		saving = scope;

		try {
			const isProject = scope === 'project';
			const res = await fetch(
				isProject
					? `/api/projects/${projectId}/visibility`
					: `/api/projects/${projectId}/files-visibility`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(isProject ? { isPublic: next } : { publicFilesEnabled: next }),
				},
			);
			if (!res.ok) {
				restoreValue(scope, previous);
				error = { scope, message: await res.text() };
				return;
			}
			clearTimeout(savedTimers[scope]);
			saved = scope;
			savedTimers[scope] = setTimeout(() => {
				if (saved === scope) saved = null;
			}, 2500);
		} catch (cause) {
			error = {
				scope,
				message: cause instanceof Error ? cause.message : 'Could not save visibility',
			};
			restoreValue(scope, previous);
		} finally {
			saving = null;
		}
	}

	onSwapOrDestroy(() => {
		clearTimeout(savedTimers.project);
		clearTimeout(savedTimers.files);
	});
</script>

<div class="visibility-picker">
	<div class="visibility-row">
		<strong>Project</strong>
		<div class="visibility-options" role="group" aria-label="Project visibility">
			<button type="button" class:active={projectValue} disabled={saving !== null} onclick={() => setVisibility('project', true)}>
				Public
			</button>
			<button type="button" class:active={!projectValue} disabled={saving !== null} onclick={() => setVisibility('project', false)}>
				Private
			</button>
		</div>
		{#if saving === 'project'}
			<p class="visibility-status muted" role="status">Saving…</p>
		{:else if saved === 'project'}
			<p class="visibility-status muted" role="status">Saved</p>
		{/if}
		{#if error?.scope === 'project'}<p class="row-error">{error.message}</p>{/if}
	</div>

	<div class="visibility-row">
		<strong>Files</strong>
		<div class="visibility-options" role="group" aria-label="File visibility">
			<button type="button" class:active={filesValue} disabled={saving !== null} onclick={() => setVisibility('files', true)}>
				Enabled
			</button>
			<button type="button" class:active={!filesValue} disabled={saving !== null} onclick={() => setVisibility('files', false)}>
				Disabled
			</button>
		</div>
		{#if saving === 'files'}
			<p class="visibility-status muted" role="status">Saving…</p>
		{:else if saved === 'files'}
			<p class="visibility-status muted" role="status">Saved</p>
		{/if}
		{#if error?.scope === 'files'}<p class="row-error">{error.message}</p>{/if}
	</div>
</div>

<style>
	.visibility-picker {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.visibility-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.visibility-row strong {
		min-width: 4rem;
	}

	.visibility-options {
		display: flex;
		gap: var(--space-1);
	}

	.visibility-options button {
		padding: var(--space-1) var(--space-4);
		font-size: 0.85rem;
	}

	.visibility-options button.active {
		background: var(--color-highlight-strong);
	}

	.visibility-status {
		font-size: 0.75rem;
		margin: 0;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
