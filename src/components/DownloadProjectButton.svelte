<script lang="ts">
	import { toastError } from '../lib/toast.svelte';

	let { projectId }: { projectId: string } = $props();

	let downloading = $state(false);

	async function download() {
		if (downloading) return;
		downloading = true;
		try {
			// A plain navigation would leave the button spinning after the file starts
			// and swallow any 413/500 as a "Failed" download in the browser's default
			// UI. Fetching it lets the error text reach the toast.
			const res = await fetch(`/api/projects/${projectId}/download-all`);
			if (!res.ok) {
				toastError(await res.text());
				return;
			}
			const blob = await res.blob();
			const cd = res.headers.get('content-disposition') ?? '';
			const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'project.zip';
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			requestAnimationFrame(() => URL.revokeObjectURL(url));
		} catch (err) {
			toastError(err instanceof Error ? err.message : 'Download failed');
		} finally {
			downloading = false;
		}
	}
</script>

<button
	type="button"
	class="btn-plain download-btn"
	onclick={download}
	disabled={downloading}
	title="Download a complete project archive for backup or import"
>
	{downloading ? 'Preparing…' : 'Download project'}
</button>

<style>
	.download-btn {
		margin-top: var(--space-2);
	}
</style>
