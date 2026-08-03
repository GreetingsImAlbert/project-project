export const prerender = false;

export async function GET({ locals }: { locals: App.Locals }) {
	const user = locals.user;
	if (!user) return new Response('Not signed in', { status: 401 });

	const [{ data, error: projectsError }, { data: taskRows, error: tasksError }] = await Promise.all([
		locals.supabase
			.from('projects')
			.select('id, name, owner_id, project_members(user_id, role, profiles(display_name, avatar))')
			.order('created_at', { ascending: false })
			.overrideTypes<
				{
					id: string;
					name: string;
					owner_id: string;
					project_members: {
						user_id: string;
						role: string;
						profiles: { display_name: string; avatar: string | null } | null;
					}[];
				}[]
			>(),
		locals.supabase
			.from('tasks')
			.select('project_id, task_assignees!inner(user_id)')
			.eq('task_assignees.user_id', user.id)
			.is('deleted_at', null)
			.neq('status', 'done')
			.overrideTypes<{ project_id: string }[]>(),
	]);

	if (projectsError || tasksError) {
		return new Response('Could not load navigation', { status: 500 });
	}

	const taskCounts = new Map<string, number>();
	for (const row of taskRows ?? []) {
		taskCounts.set(row.project_id, (taskCounts.get(row.project_id) ?? 0) + 1);
	}

	const projects = (data ?? []).map((project) => {
		const owner = (project.project_members ?? []).find((member) => member.user_id === project.owner_id)?.profiles;
		return {
			id: project.id,
			name: project.name,
			owner: {
				displayName: owner?.display_name ?? 'Unknown',
				avatar: owner?.avatar ?? null,
			},
			taskCount: taskCounts.get(project.id) ?? 0,
		};
	});

	return Response.json({ projects }, { headers: { 'cache-control': 'private, no-store' } });
}
