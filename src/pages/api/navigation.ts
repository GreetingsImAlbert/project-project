export const prerender = false;

import { appNowTime, appToday } from '../../lib/today';

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
			.select('project_id, deadline, deadline_time, task_assignees!inner(user_id)')
			.eq('task_assignees.user_id', user.id)
			.is('deleted_at', null)
			.neq('status', 'done')
			.overrideTypes<{ project_id: string; deadline: string | null; deadline_time: string }[]>(),
	]);

	if (projectsError || tasksError) {
		return new Response('Could not load navigation', { status: 500 });
	}

	// The same deadline rule displayStatus applies on the tasks page: overdue is never
	// stored, so the sidebar derives it from the same fixed Manila clock the rest of
	// the app renders by. Everything open that isn't overdue counts as ongoing.
	const today = appToday();
	const nowTime = appNowTime();

	const overdueTaskCounts = new Map<string, number>();
	const ongoingTaskCounts = new Map<string, number>();
	for (const row of taskRows ?? []) {
		const overdue = row.deadline
			? row.deadline < today || (row.deadline === today && row.deadline_time < nowTime)
			: false;
		const counts = overdue ? overdueTaskCounts : ongoingTaskCounts;
		counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1);
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
			overdueTaskCount: overdueTaskCounts.get(project.id) ?? 0,
			ongoingTaskCount: ongoingTaskCounts.get(project.id) ?? 0,
		};
	});

	return Response.json({ projects }, { headers: { 'cache-control': 'private, no-store' } });
}
