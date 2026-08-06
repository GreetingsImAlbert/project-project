<script lang="ts">
	import { onMount } from 'svelte';
	import FileViewerPanel from './FileViewerPanel.svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import {
		VIEWER_COMMAND_EVENT,
		VIEWER_SAVED_EVENT,
		VIEWER_STATE_EVENT,
		loadActiveViewerFile,
		loadViewerTabs,
		saveViewerTabs,
		type ViewerCommand,
		type ViewerState,
		type ViewerTab,
	} from '../lib/viewer-tabs';

	let { userId }: { userId: string } = $props();
	const tabsStorageKey = () => `p2-viewer-tabs-${userId}`;
	const activeFileStorageKey = () => `p2-viewer-active-file-${userId}`;
	const initialTabs = loadViewerTabs(tabsStorageKey());
	let tabs = $state<ViewerTab[]>(initialTabs);
	let activeFileId = $state<string | null>(loadActiveViewerFile(activeFileStorageKey(), initialTabs));
	let editOnOpen = $state(false);
	let panelWidth = $state(0);
	let file = $derived(activeFileId ? tabs.find((tab) => tab.id === activeFileId) ?? null : null);

	function publishState() {
		window.dispatchEvent(new CustomEvent<ViewerState>(VIEWER_STATE_EVENT, {
			detail: { activeFileId, width: panelWidth },
		}));
	}

	function selectTab(fileId: string) {
		if (!tabs.some((tab) => tab.id === fileId)) return;
		editOnOpen = false;
		activeFileId = fileId;
	}

	function closeTab(fileId: string) {
		const index = tabs.findIndex((tab) => tab.id === fileId);
		if (index < 0) return;

		const remaining = tabs.filter((tab) => tab.id !== fileId);
		tabs = remaining;
		if (activeFileId === fileId) {
			activeFileId = remaining[Math.min(index, remaining.length - 1)]?.id ?? null;
		}
	}

	function handleCommand(event: Event) {
		const command = (event as CustomEvent<ViewerCommand>).detail;
		if (command.type === 'open') {
			tabs = tabs.some((tab) => tab.id === command.file.id)
				? tabs.map((tab) => (tab.id === command.file.id ? command.file : tab))
				: [...tabs, command.file];
			editOnOpen = command.edit ?? false;
			activeFileId = command.file.id;
		} else if (command.type === 'close-file') {
			closeTab(command.fileId);
		} else if (command.type === 'rename-file') {
			tabs = tabs.map((tab) =>
				tab.id === command.fileId ? { ...tab, filename: command.filename } : tab
			);
		} else {
			publishState();
		}
	}

	$effect(() => {
		saveViewerTabs(tabsStorageKey(), tabs);
		try {
			if (activeFileId) localStorage.setItem(activeFileStorageKey(), activeFileId);
			else localStorage.removeItem(activeFileStorageKey());
		} catch {
			// Storage is optional; the persisted island still retains state for this session.
		}
		publishState();
	});

	$effect(() => {
		panelWidth;
		publishState();
	});

	onMount(() => {
		window.addEventListener(VIEWER_COMMAND_EVENT, handleCommand);
		publishState();
		return onSwapOrDestroy(
			() => window.removeEventListener(VIEWER_COMMAND_EVENT, handleCommand),
			'[data-global-file-viewer]'
		);
	});
</script>

<div data-global-file-viewer>
	<FileViewerPanel
		{file}
		{tabs}
		{editOnOpen}
		zIndex={110}
		onTabSelect={selectTab}
		onTabClose={closeTab}
		onWidthChange={(width) => (panelWidth = width)}
		onFileRestore={selectTab}
		onSaved={(fileId, sizeBytes) => {
			window.dispatchEvent(new CustomEvent(VIEWER_SAVED_EVENT, { detail: { fileId, sizeBytes } }));
		}}
		onClose={() => {
			editOnOpen = false;
			activeFileId = null;
		}}
	/>
</div>

<style>
	[data-global-file-viewer] {
		display: contents;
	}
</style>
