<script lang="ts">
	interface SidebarProject {
		id: string;
		name: string;
		ownerName: string;
	}

	let {
		projects,
		currentPath,
		displayName,
	}: {
		projects: SidebarProject[];
		currentPath: string;
		displayName: string;
	} = $props();

	let currentProjectId = $derived.by(() => {
		const match = currentPath.match(/^\/projects\/([^/]+)/);
		return match ? match[1] : null;
	});
</script>

<aside class="app-sidebar">
	<div class="sidebar-content">
		<p class="sidebar-welcome">Welcome, {displayName}</p>

		<nav class="sidebar-nav">
			<a href="/" class="nav-link" class:active={currentPath === '/'}>Dashboard</a>
			<a href="/projects" class="nav-link" class:active={currentPath === '/projects'}>Projects</a>

			<ul class="project-list">
				{#each projects as project}
					<li>
						<a
							href={`/projects/${project.id}`}
							class="nav-link project-link"
							class:active={currentProjectId === project.id}
						>
							{project.ownerName}/{project.name}
						</a>
					</li>
				{/each}
				<li>
					<a href="/projects/new" class="nav-link add-project">+ Add project</a>
				</li>
			</ul>
		</nav>
	</div>
</aside>

<style>
	.app-sidebar {
		flex: 0 0 280px;
		display: flex;
		background: var(--color-surface-sidebar);
		border-right: 1px solid var(--color-border);
		min-height: 0;
	}

	.sidebar-content {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--space-6) var(--space-4) var(--space-8);
	}

	.sidebar-welcome {
		font-size: 0.82rem;
		margin: 0 0 var(--space-6);
		padding: 0 var(--space-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sidebar-nav {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: 0.85rem;
	}

	/* Location is carried by a background fill, not weight — bolding every top-level
	   entry made the whole nav read as selected. */
	.nav-link {
		display: block;
		padding: var(--space-2) var(--space-3);
		border-bottom: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.nav-link:hover {
		background: var(--color-highlight);
		border-bottom: none;
	}

	.nav-link.active {
		background: var(--color-highlight-strong);
	}

	.project-list {
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0 0 0 var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.project-link {
		font-size: 0.82rem;
	}

	.add-project {
		font-size: 0.82rem;
		color: var(--color-muted);
	}

	.add-project:hover {
		color: var(--color-fg);
	}

	@media (max-width: 768px) {
		.app-sidebar {
			display: none;
		}
	}
</style>
