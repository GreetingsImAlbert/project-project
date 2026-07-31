<script lang="ts">
	import Avatar from './Avatar.svelte';

	interface SidebarMember {
		displayName: string;
		avatar: string | null;
	}

	interface SidebarProject {
		id: string;
		name: string;
		// Owner first — the order is fixed by the layout that loads them.
		members: SidebarMember[];
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

	// Owner plus two others; past that the row has no width left for the project name,
	// which is the thing being navigated to, so the rest become a count.
	const MAX_AVATARS = 3;

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
							<span class="project-name">{project.name}</span>
							<span class="project-members">
								{#each project.members.slice(0, MAX_AVATARS) as member}
									<span class="member-avatar" title={member.displayName}>
										<Avatar avatar={member.avatar} displayName={member.displayName} size={18} />
									</span>
								{/each}
								{#if project.members.length > MAX_AVATARS}
									<span class="member-more">+{project.members.length - MAX_AVATARS}</span>
								{/if}
							</span>
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
		margin: 0 0 var(--space-8);
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

	/* Name and faces share one line: the faces sit directly after the name rather than
	   against the far edge, so the gap here is the only thing separating the two — it has
	   to be wide enough that the owner's picture doesn't read as part of the name. */
	.project-link {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: 0.82rem;
	}

	.project-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.project-members {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: 0 0 auto;
	}

	.member-avatar {
		display: flex;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--color-border);
	}

	.member-more {
		font-size: 0.7rem;
		color: var(--color-muted);
		line-height: 1;
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
