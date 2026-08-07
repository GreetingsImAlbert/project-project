export const prerender = false;

import { env } from 'cloudflare:workers';
import { appNowTime, appToday } from '../../lib/today';
import { getSupabaseAdmin } from '../../lib/supabase/admin';

export async function GET({ locals }: { locals: App.Locals }) {
	const user = locals.user;
	if (!user) {
		const { data: publicProjectRows, error } = await getSupabaseAdmin(env)
			.from('projects')
			.select('id, name')
			.or('is_public.eq.true,public_files_enabled.eq.true')
			.order('created_at', { ascending: false });

		if (error) return new Response('Could not load navigation', { status: 500 });

		return Response.json(
			{ projects: [], publicProjects: (publicProjectRows ?? []).map((project) => ({ id: project.id, name: project.name })) },
			{ headers: { 'cache-control': 'private, no-store' } },
		);
	}

	const [
		{ data, error: projectsError },
		{ data: taskRows, error: tasksError },
		{ data: publicProjectRows, error: publicProjectsError },
	] = await Promise.all([
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
			.select('project_id, start_date, deadline, deadline_time, task_assignees!inner(user_id)')
			.eq('task_assignees.user_id', user.id)
			.is('deleted_at', null)
			.neq('status', 'done')
			.overrideTypes<{
				project_id: string;
				start_date: string | null;
				deadline: string | null;
				deadline_time: string;
			}[]>(),
		// This endpoint is authenticated, but the service-role query keeps the
		// public sidebar slice independent of the member-only projects policy.
		// Discoverable = either the Overview or the Files section is public.
		getSupabaseAdmin(env)
			.from('projects')
			.select('id, name')
			.or('is_public.eq.true,public_files_enabled.eq.true')
			.order('created_at', { ascending: false }),
	]);

	if (projectsError || tasksError || publicProjectsError) {
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
		if (row.start_date && row.start_date > today) continue;

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

	const memberProjectIds = new Set(projects.map((project) => project.id));
	const publicProjects = (publicProjectRows ?? [])
		.filter((project) => !memberProjectIds.has(project.id))
		.map((project) => ({ id: project.id, name: project.name }));

	return Response.json({ projects, publicProjects }, { headers: { 'cache-control': 'private, no-store' } });
}
