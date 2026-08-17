import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../../lib/error-report';
import {
	createPersonalJournal,
	ensureJournalDraft,
	ensureJournalsFolder,
	journalSchemaClient,
} from '../../../../../lib/journal';
import { getSupabaseAdmin } from '../../../../../lib/supabase/admin';

export const prerender = false;

async function requestBody(request: Request): Promise<{ restore?: unknown } | null> {
	const text = await request.text();
	if (!text) return {};
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value) ? value as { restore?: unknown } : null;
	} catch {
		return null;
	}
}

// Idempotently creates the caller's one personal journal. A deleted journal is
// never silently replaced: the client must confirm restoration explicitly.
export const POST: APIRoute = async ({ params, request, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	const projectId = params.id;
	if (!projectId) return new Response('Project not found', { status: 404 });

	const body = await requestBody(request);
	if (!body || (body.restore !== undefined && typeof body.restore !== 'boolean')) {
		return new Response('Invalid request body', { status: 400 });
	}

	const { data: membership, error: membershipError } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (membershipError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to check journal creation membership: ${membershipError.message}`,
			action: 'Failed to create journal.',
			context: { projectId },
		});
	}
	if (!membership || (membership.role !== 'owner' && membership.role !== 'editor')) {
		return new Response('Forbidden', { status: 403 });
	}

	const admin = getSupabaseAdmin(env);
	const db = journalSchemaClient(admin);
	const { data: journals, error: journalError } = await db
		.from('files')
		.select('id, filename, deleted_at')
		.eq('project_id', projectId)
		.eq('journal_kind', 'personal')
		.eq('uploaded_by', locals.user.id)
		.order('deleted_at', { ascending: true, nullsFirst: true });
	if (journalError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to find personal journal: ${journalError.message}`,
			action: 'Failed to create journal.',
			context: { projectId },
		});
	}

	const active = (journals ?? []).find((journal: { deleted_at: string | null }) => !journal.deleted_at);
	if (active) {
		try {
			await ensureJournalDraft(locals.supabase, projectId, active.id);
			return Response.json({ created: false, journal: { fileId: active.id, filename: active.filename } });
		} catch (error) {
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to ensure personal journal draft: ${error instanceof Error ? error.message : String(error)}`,
				action: 'Failed to create journal.',
				context: { projectId, journalFileId: active.id },
			});
		}
	}

	const deleted = (journals ?? []).find((journal: { deleted_at: string | null }) => journal.deleted_at);
	if (deleted && body.restore !== true) {
		return Response.json({
			restoreRequired: true,
			journal: { fileId: deleted.id, filename: deleted.filename },
		}, { status: 409 });
	}

	if (deleted) {
		let folder: { id: string };
		try {
			folder = await ensureJournalsFolder(admin, projectId);
		} catch (error) {
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to ensure restored journal folder: ${error instanceof Error ? error.message : String(error)}`,
				action: 'Failed to restore journal.',
				context: { projectId, journalFileId: deleted.id },
			});
		}
		const { error: restoreError } = await db
			.from('files')
			.update({ deleted_at: null, folder_id: folder.id })
			.eq('id', deleted.id)
			.eq('project_id', projectId)
			.eq('journal_kind', 'personal')
			.not('deleted_at', 'is', null);
		if (restoreError) {
			if (restoreError.code === '23505') {
				return Response.json({ error: 'Journal could not be restored because an active journal already exists.' }, { status: 409 });
			}
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to restore personal journal: ${restoreError.message}`,
				action: 'Failed to restore journal.',
				context: { projectId, journalFileId: deleted.id },
			});
		}

		try {
			await ensureJournalDraft(locals.supabase, projectId, deleted.id);
		} catch (error) {
			await db.from('files').update({ deleted_at: deleted.deleted_at }).eq('id', deleted.id);
			return errorResponse({
				request,
				userId: locals.user.id,
				privateMessage: `Failed to recreate restored journal draft: ${error instanceof Error ? error.message : String(error)}`,
				action: 'Failed to restore journal.',
				context: { projectId, journalFileId: deleted.id },
			});
		}

		return Response.json({ restored: true, journal: { fileId: deleted.id, filename: deleted.filename } });
	}

	const { data: profile, error: profileError } = await locals.supabase
		.from('profiles')
		.select('display_name')
		.eq('id', locals.user.id)
		.single();
	if (profileError || !profile) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to load journal creator profile: ${profileError?.message ?? 'profile missing'}`,
			action: 'Failed to create journal.',
			context: { projectId },
		});
	}

	try {
		const journal = await createPersonalJournal(admin, env, projectId, locals.user.id, profile.display_name);
		await ensureJournalDraft(locals.supabase, projectId, journal.id);
		return Response.json({ created: true, journal: { fileId: journal.id } }, { status: 201 });
	} catch (error) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Failed to create personal journal: ${error instanceof Error ? error.message : String(error)}`,
			action: 'Failed to create journal.',
			context: { projectId },
		});
	}
};
