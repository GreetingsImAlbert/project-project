import type { APIRoute } from 'astro';
import { isCategoryColorIndex } from '../../../../../lib/category-color';

export const prerender = false;

// Sets the colour slot for one category in one project. Category colours are a
// project-level setting rather than a per-task one — the whole point is that every
// task in a category shares a colour — so this is its own endpoint instead of a field
// on the task create/update forms: changing a colour shouldn't require editing a task,
// and editing a task shouldn't quietly rewrite a colour somebody else picked.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id;

	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.maybeSingle();

	// Same rights as the tasks themselves: base editor, not can_edit_money.
	if (!membership || !['owner', 'editor'].includes(membership.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await request.formData();
	const name = formData.get('name')?.toString().trim();
	const colorIndex = Number(formData.get('color_index'));

	if (!name) {
		return new Response('Category name is required', { status: 400 });
	}
	// Matches the tasks.category limit — the two hold the same free text and a name
	// this table would accept but `tasks` wouldn't could never be reached by a task.
	if (name.length > 100) {
		return new Response('Category: max 100 characters', { status: 400 });
	}
	// The check constraint would catch this too, but a 400 saying what's wrong beats a
	// 500 carrying a Postgres message.
	if (!isCategoryColorIndex(colorIndex)) {
		return new Response('Unknown colour', { status: 400 });
	}

	const { data, error } = await locals.supabase
		.from('task_categories')
		.upsert({ project_id: projectId!, name, color_index: colorIndex }, { onConflict: 'project_id,name' })
		.select('name, color_index')
		.single();

	if (error || !data) {
		return new Response(`Failed to save category colour: ${error?.message ?? 'unknown error'}`, { status: 500 });
	}

	return Response.json({ name: data.name, color_index: data.color_index });
};
