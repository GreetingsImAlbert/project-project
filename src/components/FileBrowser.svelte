<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import FileList from './FileList.svelte';
	import FileViewerPanel from './FileViewerPanel.svelte';
	import UploadForm from './UploadForm.svelte';
	import ProjectStorageUsed from './ProjectStorageUsed.svelte';
	import Toasts from './Toasts.svelte';
	import { adjustProjectStorage } from '../lib/project-storage.svelte';
	import { toastError, toastSuccess } from '../lib/toast.svelte';
	import { formatBytes } from '../lib/format-bytes';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { fileKind } from '../lib/file-kind';

	interface Folder {
		id: string;
		name: string;
		parent_folder_id: string | null;
	}

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		uploaded_by: string | null;
		// Set once the uploader's account is hard-deleted (uploaded_by goes null at
		// the same moment) — the grace period before the purge cron removes the file
		// is measured from this, not from created_at.
		uploader_deleted_at?: string | null;
		profiles: { display_name: string } | null;
		// Absent (rather than false) on rows this component creates itself — an upload
		// or a copy is never the project's Journal file, so there's nothing to select.
		is_journal?: boolean;
	}

	let {
		projectId,
		currentUserId,
		canEdit,
		initialAllFolders,
		initialFolderId,
		initialFiles,
		initialAvailableBytes,
		initialViewMode,
		initialStorageBytes,
		initialStorageFailed,
	}: {
		projectId: string;
		currentUserId: string;
		canEdit: boolean;
		initialAllFolders: Folder[];
		initialFolderId: string | null;
		initialFiles: FileRow[];
		initialAvailableBytes: number | null;
		initialViewMode?: 'list' | 'grid';
		initialStorageBytes: number;
		initialStorageFailed: boolean;
	} = $props();

	let currentFolderId = $state(initialFolderId);
	let files = $state(initialFiles);
	let allFolders = $state(initialAllFolders);
	let availableBytes = $state(initialAvailableBytes);
	let loading = $state(false);
	let error = $state<string | null>(null);
	function getInitialViewMode(): 'list' | 'grid' {
		if (initialViewMode) return initialViewMode;
		if (typeof localStorage === 'undefined') return 'grid';
		return localStorage.getItem('p2-file-view-mode') === 'list' ? 'list' : 'grid';
	}

	let viewMode = $state<'list' | 'grid'>(getInitialViewMode());
	let backStack = $state<(string | null)[]>([]);
	let viewingFile = $state<FileRow | null>(null);
	let viewerEditOnOpen = $state(false);

	let creatingFolder = $state(false);
	let createMode = $state<'folder' | 'file' | 'upload'>('folder');
	// UploadForm's in-flight stage text, shown on the meta row in place of the
	// Available: figure so an upload in progress never changes the panel's height.
	let uploadStatus = $state('');
	let newFolderName = $state('');
	let newFileName = $state('');
	// Which of the New file panel's two buttons is mid-flight, so only that one shows a
	// pending label while both are disabled.
	let creatingFile = $state<'create' | 'edit' | null>(null);

	// Only a name the viewer can actually open is worth handing straight to the editor.
	let newFileEditable = $derived(
		newFileName.trim() !== '' && fileKind(newFileName.trim()) !== 'unsupported'
	);
	let deletingFolderId = $state<string | null>(null);
	let folderError = $state<{ id: string; message: string } | null>(null);
	let openFolderActionsId = $state<string | null>(null);

	function setCreateMode(mode: 'folder' | 'file' | 'upload') {
		createMode = mode;
	}

	function openViewer(file: FileRow, startEditing = false) {
		viewerEditOnOpen = startEditing;
		viewingFile = file;
	}

	function toggleFolderActions(folderId: string) {
		openFolderActionsId = openFolderActionsId === folderId ? null : folderId;
	}

	function handleWindowClick(e: MouseEvent) {
		if (openFolderActionsId === null) return;

		// See FileList's copy of this: the composed path (fixed at dispatch) survives the
		// popover's own buttons detaching mid-click, and the marker sits on the toggle as
		// well so opening the popover doesn't immediately close it. Files carry their own
		// marker, so clicking a file's Actions toggle closes this one.
		const insideActions = e
			.composedPath()
			.some((node) => node instanceof Element && node.hasAttribute('data-folder-actions'));

		if (!insideActions) openFolderActionsId = null;
	}

	let folderById = $derived(new Map(allFolders.map((f) => [f.id, f])));

	let subfolders = $derived(
		allFolders.filter((f) => (f.parent_folder_id ?? null) === (currentFolderId ?? null))
	);

	let breadcrumbs = $derived.by(() => {
		const crumbs: Folder[] = [];
		let cursor = currentFolderId ? folderById.get(currentFolderId) : undefined;
		while (cursor) {
			crumbs.unshift(cursor);
			cursor = cursor.parent_folder_id ? folderById.get(cursor.parent_folder_id) : undefined;
		}
		return crumbs;
	});

	let parentFolderId = $derived(
		breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].parent_folder_id : null
	);

	function setViewMode(mode: 'list' | 'grid') {
		viewMode = mode;
		localStorage.setItem('p2-file-view-mode', mode);
		document.cookie = `p2-file-view-mode=${mode}; path=/; max-age=31536000; samesite=lax`;
	}

	function hrefFor(folderId: string | null) {
		return folderId ? `/projects/${projectId}/files?folder=${folderId}` : `/projects/${projectId}/files`;
	}

	// Bumped on every navigate() call so a stale response from an earlier click (e.g. two
	// folders clicked in quick succession) can't overwrite a newer one that already resolved.
	let requestSeq = 0;

	async function navigate(folderId: string | null, historyMode: 'push' | 'replace' | 'none' = 'push') {
		if (folderId === currentFolderId) return;

		const requestId = ++requestSeq;
		loading = true;
		error = null;

		const url = folderId
			? `/api/projects/${projectId}/files?folderId=${folderId}`
			: `/api/projects/${projectId}/files`;

		const res = await fetch(url);

		if (requestId !== requestSeq) return;

		if (!res.ok) {
			error = await res.text();
			loading = false;
			return;
		}

		files = await res.json();
		currentFolderId = folderId;
		loading = false;

		// A *null* history state, deliberately. Astro's ClientRouter listens on popstate too,
		// and treats any entry carrying state as one of its own — it reads `state.index` and
		// runs a full document swap. Its handler returns immediately when `ev.state` is null,
		// which is the escape hatch for exactly this: history entries owned by the page rather
		// than by the router. Folder browsing stays a single JSON fetch, and Back on a folder
		// entry reaches only the handler below (which reads the URL, never ev.state), while
		// Back off the *first* folder entry lands on Astro's own entry and correctly leaves
		// the Files page. Don't put a state object back here.
		if (historyMode === 'push') {
			history.pushState(null, '', hrefFor(folderId));
		} else if (historyMode === 'replace') {
			// Preserves whatever the current entry already holds rather than nulling it — an
			// in-app Back that landed on an Astro-owned entry must not strip its index.
			history.replaceState(history.state, '', hrefFor(folderId));
		}
	}

	function navigateWithHistory(folderId: string | null) {
		if (folderId === currentFolderId || loading) return;
		backStack = [...backStack, currentFolderId];
		navigate(folderId, 'push');
	}

	function goBack() {
		if (backStack.length === 0 || loading) return;
		const previous = backStack[backStack.length - 1];
		backStack = backStack.slice(0, -1);
		// 'replace', not 'push' — this is going back, not forward, so the URL should reflect
		// the folder we land on without growing the real browser history stack (that stack
		// is what the native Back/Forward buttons use, and shouldn't gain a duplicate entry
		// every time the in-app Back button is clicked).
		navigate(previous, 'replace');
	}

	function handleLinkClick(e: MouseEvent, folderId: string | null) {
		e.preventDefault();
		navigateWithHistory(folderId);
	}

	function handleFileMoved(fileId: string, targetFolderId: string | null) {
		if (targetFolderId !== currentFolderId) {
			files = files.filter((f) => f.id !== fileId);
		}
	}

	function handleFileCopied(file: FileRow, targetFolderId: string | null) {
		if (targetFolderId === currentFolderId) {
			files = [...files, file];
		}
		adjustProjectStorage(file.size_bytes ?? 0);
		// copy.ts always attributes the copy to the current user (uploaded_by is
		// the copier, not the source file's original uploader), so this always
		// consumes the current viewer's own quota regardless of the destination.
		// availableBytes stays null (unknown) if the initial read already failed.
		if (availableBytes !== null) availableBytes -= file.size_bytes ?? 0;
	}

	function handleUploaded(file: FileRow) {
		files = [...files, file];
		if (availableBytes !== null) availableBytes -= file.size_bytes ?? 0;
		adjustProjectStorage(file.size_bytes ?? 0);
	}

	function handleFileDeleted(fileId: string) {
		const deletedFile = files.find((f) => f.id === fileId);
		files = files.filter((f) => f.id !== fileId);
		// The preview would keep showing a file that no longer exists.
		if (viewingFile?.id === fileId) viewingFile = null;
		adjustProjectStorage(-(deletedFile?.size_bytes ?? 0));
		// Only give quota back to the current viewer if it was actually their own
		// file — deleting a project-mate's upload frees their quota, not ours.
		if (deletedFile?.uploaded_by === currentUserId && availableBytes !== null) {
			availableBytes += deletedFile?.size_bytes ?? 0;
		}
	}

	function handleFileSaved(fileId: string, sizeBytes: number) {
		const saved = files.find((f) => f.id === fileId);
		if (!saved) return;

		const delta = sizeBytes - (saved.size_bytes ?? 0);
		files = files.map((f) => (f.id === fileId ? { ...f, size_bytes: sizeBytes } : f));
		adjustProjectStorage(delta);
		// An edit is charged to whoever uploaded the file (that's the column the quota
		// sums by), so it only moves the current viewer's own headroom when it's theirs.
		if (saved.uploaded_by === currentUserId && availableBytes !== null) availableBytes -= delta;
	}

	// The submit buttons stay enabled whether or not their preconditions hold — an
	// unmet one is reported as a toast on click rather than silently greying the
	// control out, so it's always clear why nothing happened.
	async function handleCreateFolder(e: SubmitEvent) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;

		const name = newFolderName.trim();
		if (!name) {
			toastError('Enter a name for the new folder.');
			return;
		}

		if (creatingFolder) return;
		creatingFolder = true;

		const body = new FormData(form);
		body.set('name', name);

		const res = await fetch(form.action, { method: 'POST', body });

		if (!res.ok) {
			toastError(await res.text());
			creatingFolder = false;
			return;
		}

		const created: Folder = await res.json();
		allFolders = [...allFolders, created];
		newFolderName = '';
		creatingFolder = false;
		toastSuccess(`Folder ${created.name} created`);
	}

	// Creates the file as zero bytes over the exact path an upload takes — presigned PUT,
	// then confirm. A dedicated endpoint would have to re-implement the size derivation,
	// the quota check and the orphan cleanup that confirm.ts already does.
	async function createEmptyFile(mode: 'create' | 'edit') {
		const filename = newFileName.trim();

		if (!filename) {
			toastError('Enter a name for the new file.');
			return;
		}

		if (mode === 'edit' && !newFileEditable) {
			toastError(`The editor can't open ${filename} — it only opens text files.`);
			return;
		}

		if (creatingFile) return;
		creatingFile = mode;

		const urlRes = await fetch(`/api/projects/${projectId}/files/upload-url`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename, size: 0 }),
		});

		if (!urlRes.ok) {
			toastError(await urlRes.text());
			creatingFile = null;
			return;
		}

		const { uploadUrl, r2Key } = await urlRes.json() as { uploadUrl: string; r2Key: string };

		// An empty Blob rather than '': a string body makes fetch add a Content-Type of its
		// own, and nothing in this flow signs one.
		const putRes = await fetch(uploadUrl, { method: 'PUT', body: new Blob([]) });

		if (!putRes.ok) {
			toastError('Could not create the file in storage');
			creatingFile = null;
			return;
		}

		const confirmRes = await fetch(`/api/projects/${projectId}/files/confirm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ r2Key, filename, folderId: currentFolderId }),
		});

		if (!confirmRes.ok) {
			const bodyText = await confirmRes.text();
			try {
				const result: { cleanedUp: boolean; error: string } = JSON.parse(bodyText);
				toastError(
					result.cleanedUp
						? `Could not create the file (cleaned up): ${result.error}`
						: `Could not create the file AND cleanup failed: ${result.error}`
				);
			} catch {
				toastError(bodyText);
			}
			creatingFile = null;
			return;
		}

		const created: FileRow = await confirmRes.json();
		// Same bookkeeping an upload does — it's zero bytes today, but the row still has to
		// reach the list and the storage figures still read from the same helpers.
		handleUploaded(created);
		newFileName = '';
		creatingFile = null;
		toastSuccess(`File ${created.filename} created`);

		if (mode === 'edit') openViewer(created, true);
	}

	async function handleDeleteFolder(folderId: string) {
		if (!confirm('Delete this folder? Any files and subfolders inside it will be deleted too.')) return;

		folderError = null;
		deletingFolderId = folderId;

		const res = await fetch(`/api/projects/${projectId}/folders/${folderId}/delete`, { method: 'POST' });

		if (!res.ok) {
			folderError = { id: folderId, message: await res.text() };
			deletingFolderId = null;
			return;
		}

		allFolders = allFolders.filter((f) => f.id !== folderId);
		deletingFolderId = null;
		openFolderActionsId = null;
	}

	// Bound by hand rather than through <svelte:window> for the click handler too: Astro's
	// ClientRouter discards an island's DOM on navigation without destroying the component,
	// so Svelte never unbinds and a second copy accumulates on every visit to this page.
	// See lib/island-teardown.ts.
	onMount(() => {
		const onPopState = () => {
			const folderId = new URLSearchParams(location.search).get('folder');
			navigate(folderId, 'none');
		};
		window.addEventListener('popstate', onPopState);
		window.addEventListener('click', handleWindowClick);
		return onSwapOrDestroy(() => {
			window.removeEventListener('popstate', onPopState);
			window.removeEventListener('click', handleWindowClick);
		});
	});
</script>

<div class="browser-meta">
	<!-- Figure + its icons are grouped so that below 640px each pair collapses to one
	     full-width row of 'label ......... icons' instead of the four parts wrapping
	     independently into a staircase. -->
	<div class="view-meta">
		<ProjectStorageUsed initialUsedBytes={initialStorageBytes} initialFailed={initialStorageFailed} />

		<div class="view-toggle">
			<button
				type="button"
				class="btn-plain"
				class:active={viewMode === 'grid'}
				aria-pressed={viewMode === 'grid'}
				aria-label="Grid view"
				title="Grid view"
				onclick={() => setViewMode('grid')}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<rect x="1" y="1" width="6" height="6" rx="1" />
					<rect x="9" y="1" width="6" height="6" rx="1" />
					<rect x="1" y="9" width="6" height="6" rx="1" />
					<rect x="9" y="9" width="6" height="6" rx="1" />
				</svg>
			</button>
			<button
				type="button"
				class="btn-plain"
				class:active={viewMode === 'list'}
				aria-pressed={viewMode === 'list'}
				aria-label="List view"
				title="List view"
				onclick={() => setViewMode('list')}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<rect x="1" y="2" width="2" height="2" rx="0.5" />
					<rect x="5" y="2" width="10" height="2" rx="1" />
					<rect x="1" y="7" width="2" height="2" rx="0.5" />
					<rect x="5" y="7" width="10" height="2" rx="1" />
					<rect x="1" y="12" width="2" height="2" rx="0.5" />
					<rect x="5" y="12" width="10" height="2" rx="1" />
				</svg>
			</button>
		</div>
	</div>

	{#if canEdit}
		<!-- Both of these sit on this row rather than above the create controls
		     themselves, so the name input, the file input and the upload dropzone all
		     stay on the same line as Back/Up and the breadcrumbs. -->
		<div class="create-meta">
			{#if uploadStatus}
				<span class="muted available-space">{uploadStatus}</span>
			{:else if availableBytes === null}
				<span class="available-space storage-error">
					Available: unavailable
					<button type="button" class="reload-btn" onclick={() => location.reload()}>⟳ Reload</button>
				</span>
			{:else}
				<span class="muted available-space">Available: {formatBytes(Math.max(availableBytes, 0))}</span>
			{/if}

			<div class="create-toggle">
				<button
					type="button"
					class="btn-plain"
					class:active={createMode === 'folder'}
					aria-pressed={createMode === 'folder'}
					aria-label="New folder"
					title="New folder"
					onclick={() => setCreateMode('folder')}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
						<path d="M1 3a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .8.4L7.5 4H14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" />
					</svg>
				</button>
				<button
					type="button"
					class="btn-plain"
					class:active={createMode === 'file'}
					aria-pressed={createMode === 'file'}
					aria-label="New file"
					title="New file"
					onclick={() => setCreateMode('file')}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
						<path d="M3.5 1h5.1L13 5.4V14.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5z" />
						<path d="M8.6 1L13 5.4H9.1a.5.5 0 0 1-.5-.5V1z" opacity="0.45" />
					</svg>
				</button>
				<button
					type="button"
					class="btn-plain"
					class:active={createMode === 'upload'}
					aria-pressed={createMode === 'upload'}
					aria-label="Upload file"
					title="Upload file"
					onclick={() => setCreateMode('upload')}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
						<path d="M8 1.5L4.5 5.5h2.25v4h2.5v-4h2.25L8 1.5z" />
						<path d="M2 9.5v4a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-4h-1.5v3h-9v-3H2z" />
					</svg>
				</button>
			</div>
		</div>
	{/if}
</div>

<div class="browser-header">
	<div class="breadcrumb-group">
		<button type="button" class="btn-plain nav-btn" onclick={goBack} disabled={backStack.length === 0}>← Back</button>
		<button type="button" class="btn-plain nav-btn" onclick={() => navigateWithHistory(parentFolderId)} disabled={currentFolderId === null}>↑ Up</button>
		<p class="breadcrumbs">
			<a href={hrefFor(null)} onclick={(e) => handleLinkClick(e, null)}>Root</a>
			{#each breadcrumbs as crumb (crumb.id)}
				{' / '}
				<a href={hrefFor(crumb.id)} onclick={(e) => handleLinkClick(e, crumb.id)}>{crumb.name}</a>
			{/each}
		</p>
	</div>

	{#if canEdit}
		<!-- All three panels stay mounted so a half-typed name or an already-picked file
		     survives a toggle to another mode and back. -->
		<div class="header-actions">
			<div class="create-panel" hidden={createMode !== 'folder'}>
				<!-- No `required`: the button is always live, and an empty name is answered
				     with a toast rather than the browser's own validation bubble. -->
				<form class="create-form" onsubmit={handleCreateFolder} action={`/api/projects/${projectId}/folders/create`}>
					<input type="hidden" name="parentFolderId" value={currentFolderId ?? ''} />
					<input type="text" name="name" bind:value={newFolderName} placeholder="New folder name" />
					<button type="submit">{creatingFolder ? 'Creating…' : 'Create'}</button>
				</form>
			</div>

			<div class="create-panel" hidden={createMode !== 'file'}>
				<!-- No hint line under the form: it would push the file list down a row as
				     soon as an unopenable name is typed. The Edit button's title says the
				     same thing, and clicking it says it as a toast. -->
				<form class="create-form" onsubmit={(e) => { e.preventDefault(); createEmptyFile('create'); }}>
					<input type="text" bind:value={newFileName} placeholder="New file name" />
					<button type="submit">
						{creatingFile === 'create' ? 'Creating…' : 'Create'}
					</button>
					<button
						type="button"
						onclick={() => createEmptyFile('edit')}
						title={newFileEditable ? 'Create the file and open it in the editor' : 'The editor only opens text files'}
					>
						{creatingFile === 'edit' ? 'Opening…' : 'Edit'}
					</button>
				</form>
			</div>

			<div class="create-panel" hidden={createMode !== 'upload'}>
				<UploadForm projectId={projectId} currentFolderId={currentFolderId} onStatus={(text) => (uploadStatus = text)} onUploaded={handleUploaded} />
			</div>
		</div>
	{/if}
</div>

{#if subfolders.length > 0}
	<ul class={viewMode === 'grid' ? 'grid-view' : 'list-plain folder-list'}>
		{#each subfolders as folder (folder.id)}
			{#if viewMode === 'grid'}
				<li class="grid-item">
					<a href={hrefFor(folder.id)} onclick={(e) => handleLinkClick(e, folder.id)} class="grid-download">
						<span class="grid-icon">📁</span>
						<span class="grid-name">{folder.name}</span>
					</a>

					{#if canEdit}
						<button type="button" class="grid-actions-toggle" data-folder-actions aria-label="Actions" onclick={() => toggleFolderActions(folder.id)}>
							{openFolderActionsId === folder.id ? '▴' : '▾'}
						</button>
					{/if}

					{#if canEdit && openFolderActionsId === folder.id}
						<div class="actions-panel" data-folder-actions transition:slide={{ duration: 150 }}>
							<button type="button" class="btn-danger" onclick={() => handleDeleteFolder(folder.id)} disabled={deletingFolderId === folder.id}>
								{deletingFolderId === folder.id ? 'Deleting…' : 'Delete'}
							</button>
						</div>
					{/if}

					{#if folderError?.id === folder.id}
						<p class="row-error">{folderError.message}</p>
					{/if}
				</li>
			{:else}
				<li class="folder-row">
					<a href={hrefFor(folder.id)} onclick={(e) => handleLinkClick(e, folder.id)}>📁 {folder.name}</a>
					{#if canEdit}
						<button type="button" class="btn-danger" onclick={() => handleDeleteFolder(folder.id)} disabled={deletingFolderId === folder.id}>
							{deletingFolderId === folder.id ? 'Deleting…' : 'Delete'}
						</button>
					{/if}
				</li>
				{#if folderError?.id === folder.id}
					<li class="row-error-item">{folderError.message}</li>
				{/if}
			{/if}
		{/each}
	</ul>
{/if}

{#if error}<p class="row-error">{error}</p>{/if}

<FileList
	canEdit={canEdit}
	currentFolderId={currentFolderId}
	allFolders={allFolders}
	files={loading ? [] : files}
	viewMode={viewMode}
	loading={loading}
	openFileId={viewingFile?.id ?? null}
	onFileOpen={(file) => openViewer(file)}
	onFileMoved={handleFileMoved}
	onFileCopied={handleFileCopied}
	onFileDeleted={handleFileDeleted}
/>
{#if loading}<p class="muted">Loading…</p>{/if}

<FileViewerPanel
	file={viewingFile}
	editOnOpen={viewerEditOnOpen}
	onClose={() => {
		viewingFile = null;
		viewerEditOnOpen = false;
	}}
	onSaved={handleFileSaved}
	onFileRestore={(fileId) => {
		const previous = files.find((f) => f.id === fileId);
		if (previous) viewingFile = previous;
	}}
/>

<Toasts />

<style>
	.browser-header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-3);
		/* Keeps the folder/file list off the create controls. Wide viewports get this from
		   the breadcrumb row's own line box; narrow ones stack the create panel directly
		   above the list, where the two would otherwise touch. */
		margin-bottom: var(--space-4);
	}

	.breadcrumb-group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: 1 1 200px;
		min-width: 0;
	}

	.breadcrumb-group .breadcrumbs {
		margin: 0;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		-webkit-mask-image: linear-gradient(to right, black calc(100% - 32px), transparent 100%);
		mask-image: linear-gradient(to right, black calc(100% - 32px), transparent 100%);
	}

	.nav-btn {
		flex: 0 0 auto;
		font-size: 0.8rem;
		padding: var(--space-1) var(--space-2);
	}

	.header-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-3);
		flex: 0 0 auto;
	}

	.create-panel[hidden] {
		display: none;
	}

	.create-form {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.create-form input[type='text'] {
		width: 220px;
		max-width: 100%;
		box-sizing: border-box;
	}

	.browser-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.browser-meta :global(p) {
		margin: 0;
	}

	/* Mirrors .create-meta's shape so the two halves of the meta row are structurally the
	   same thing: a figure and the icon group it belongs to. */
	.view-meta {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex: 0 1 auto;
		min-width: 0;
	}

	.view-toggle {
		display: flex;
		gap: var(--space-2);
		flex: 0 0 auto;
	}

	/* Pushed to the far edge so it lines up over the create controls below it, which sit
	   at the end of the header row. The Available: figure travels with it: it belongs to
	   the Upload panel, and this row is the only place it can be read *above* the
	   dropzone without offsetting the dropzone from the other two panels' inputs. */
	.create-meta {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex: 0 0 auto;
		margin-left: auto;
	}

	.create-toggle {
		display: flex;
		gap: var(--space-2);
		flex: 0 0 auto;
	}

	.available-space {
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.storage-error {
		color: var(--color-danger);
	}

	.reload-btn {
		background: none;
		border: none;
		padding: 0;
		margin-left: var(--space-1);
		color: var(--color-danger);
		text-decoration: underline;
		cursor: pointer;
		font-size: inherit;
	}

	.view-toggle button,
	.create-toggle button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-1);
		line-height: 0;
	}

	.view-toggle svg,
	.create-toggle svg {
		width: 14px;
		height: 14px;
		fill: currentColor;
	}

	.view-toggle button.active,
	.create-toggle button.active {
		background: var(--color-fg);
		color: var(--color-bg);
	}

	.folder-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.grid-view {
		list-style: none;
		margin: 0 0 var(--space-4);
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: var(--space-3);
	}

	.grid-item {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		border: 1px solid var(--color-border);
		padding: var(--space-3) var(--space-2);
		text-align: center;
	}

	.grid-download {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		color: var(--color-fg);
		border-bottom: none;
	}

	.grid-download:hover {
		border-bottom: none;
	}

	.grid-icon {
		font-size: 1.5rem;
		line-height: 1;
	}

	.grid-name {
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 0.8rem;
	}

	.grid-actions-toggle {
		background: none;
		border: none;
		padding: 0 var(--space-2);
		color: var(--color-muted);
		font-size: 0.9rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.grid-actions-toggle:hover {
		color: var(--color-fg);
	}

	.actions-panel {
		position: absolute;
		top: calc(100% + var(--space-1));
		left: 0;
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-2);
	}

	.actions-panel button {
		width: 100%;
	}

	.row-error-item {
		color: var(--color-danger);
		border-top: none;
		padding-top: 0;
	}

	.row-error {
		color: var(--color-danger);
	}

	/* Keep this block last. Media queries add no specificity, so an override here only
	   beats the base rule it targets by coming later in the source — which is exactly
	   what the old placement (above .create-meta) got wrong, leaving the Available:
	   figure and the create icons pinned to the right edge on their own wrapped line. */
	@media (max-width: 640px) {
		.browser-meta {
			flex-direction: column;
			align-items: stretch;
			gap: var(--space-2);
		}

		/* One full-width row each, figure left and icons right, instead of four parts
		   wrapping into a staircase. */
		.view-meta,
		.create-meta {
			justify-content: space-between;
			margin-left: 0;
		}

		.browser-header {
			flex-direction: column;
			align-items: stretch;
			margin-bottom: var(--space-5);
		}

		.breadcrumb-group {
			flex-basis: auto;
		}

		/* global.css turns every form into a column below 640px. These panels are the
		   exception: the input wants the full width, but its buttons belong beside each
		   other on the line under it, not stacked and centre-aligned one per row. */
		.create-form {
			flex-direction: row;
		}

		.create-form input[type='text'] {
			flex: 1 1 100%;
			width: 100%;
		}

		.create-form button {
			flex: 1 1 0;
		}
	}
</style>