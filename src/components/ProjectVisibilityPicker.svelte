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
		<button
			type="button"
			class="visibility-switch"
			class:active={projectValue}
			role="switch"
			aria-checked={projectValue}
			aria-label="Project visibility"
			disabled={saving !== null}
			title={projectValue ? 'Make project private' : 'Make project public'}
			onclick={() => setVisibility('project', !projectValue)}
		>
			<span class="visibility-switch-track" aria-hidden="true"><span class="visibility-switch-thumb"></span></span>
			<span class="visibility-switch-label">{projectValue ? 'Public' : 'Private'}</span>
		</button>
		{#if saving === 'project'}
			<p class="visibility-status muted" role="status">Saving…</p>
		{:else if saved === 'project'}
			<p class="visibility-status muted" role="status">Saved</p>
		{/if}
		{#if error?.scope === 'project'}<p class="row-error">{error.message}</p>{/if}
	</div>

	<div class="visibility-row">
		<strong>Files</strong>
		<button
			type="button"
			class="visibility-switch"
			class:active={filesValue}
			role="switch"
			aria-checked={filesValue}
			aria-label="File visibility"
			disabled={saving !== null}
			title={filesValue ? 'Make files private' : 'Make files public'}
			onclick={() => setVisibility('files', !filesValue)}
		>
			<span class="visibility-switch-track" aria-hidden="true"><span class="visibility-switch-thumb"></span></span>
			<span class="visibility-switch-label">{filesValue ? 'Public' : 'Private'}</span>
		</button>
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

	.visibility-switch {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg);
		color: var(--color-fg);
		cursor: pointer;
	}

	.visibility-switch.active {
		background: var(--color-highlight);
	}

	.visibility-switch:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}

	.visibility-switch-track {
		position: relative;
		display: block;
		width: 2rem;
		height: 1.1rem;
		border-radius: 999px;
		background: var(--color-muted);
		transition: background 0.12s ease;
	}

	.visibility-switch.active .visibility-switch-track {
		background: var(--color-highlight-strong);
	}

	.visibility-switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(1.1rem - 4px);
		height: calc(1.1rem - 4px);
		border-radius: 50%;
		background: var(--color-bg);
		transition: transform 0.12s ease;
	}

	.visibility-switch.active .visibility-switch-thumb {
		transform: translateX(0.9rem);
	}

	.visibility-switch-label {
		font-size: 0.85rem;
		font-weight: 700;
		letter-spacing: 0.02em;
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
