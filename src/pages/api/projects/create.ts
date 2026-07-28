import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async({ request, locals, redirect }) => {
    if (!locals.user) {
        return new Response('Unauthorized', { status: 401 });
    }

    const formData = await request.formData();
    const name = formData.get('name')?.toString();
    const description = formData.get('description')?.toString().trim() || null;

    if (!name) {
        return new Response('Project name is required', { status: 400 });
    }

    if (name.length > 200) {
        return new Response('Project name: max 200 characters', { status: 400 });
    }

    if (description && description.length > 2000) {
        return new Response('Max 2000 characters', { status: 400 });
    }

    const { error } = await locals.supabase
        .from('projects')
        .insert({ name, description, owner_id: locals.user.id });

    if (error) {
        return new Response(`Failed to create project: ${error.message}`, { status: 500 });
    }

    return redirect('/projects');
}