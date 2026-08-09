import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { zip, type ZipEntry } from '../../../../lib/zip';
import { TASK_COLUMNS, normalizeTask, type RawTaskRow } from '../../../../lib/task-columns';
import { TRANSACTION_COLUMNS } from '../../../../lib/transaction-columns';
import { GHOST_COLUMNS } from '../../../../lib/ghost-members';

export const prerender = false;

// A single Worker isolate is capped at ~128 MB, and the ZIP is built in memory
// (see lib/zip.ts): every file's bytes live in the isolate at once, alongside
// the assembled ZIP itself. This ceiling leaves headroom for both — a project
// past it is refused rather than OOM-ing the request mid-stream. Well above what
// a mechanical-engineering student's project typically holds; if this ever
// becomes the wrong shape we'd switch to streaming with data descriptors.
const MAX_DOWNLOAD_BYTES = 80 * 1_000_000;

const encoder = new TextEncoder();
const textEntry = (name: string, body: string): ZipEntry => ({ name, bytes: encoder.encode(body) });
const jsonEntry = (name: string, data: unknown): ZipEntry =>
	textEntry(name, `${JSON.stringify(data, null, 2)}\n`);

// Windows/macOS/Linux disagree on quite a few characters; replaced rather than
// dropped so two differently-named files/folders can't collapse onto the same
// name inside the archive. Kept in sync with lib/download.ts's safeFilePart —
// same reasoning, different call site (that one runs client-side over a project
// name, this one runs server-side over every stored filename and folder name).
function safeName(raw: string): string {
	const cleaned = raw
		.replace(/[<>:"/\\|?*]/g, '-')
		.split('')
		.filter((ch) => ch.codePointAt(0)! >= 0x20)
		.join('')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '');
	return cleaned || 'untitled';
}

// Two files with the same name in the same folder — legal in `files`, illegal in
// a directory. Second and later occurrences get " (2)", " (3)", … suffixed
// before the extension, same shape Windows and browsers use for duplicate
// downloads.
function dedupe(taken: Set<string>, name: string): string {
	if (!taken.has(name)) {
		taken.add(name);
		return name;
	}
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let i = 2; ; i++) {
		const candidate = `${stem} (${i})${ext}`;
		if (!taken.has(candidate)) {
			taken.add(candidate);
			return candidate;
		}
	}
}

export const GET: APIRoute = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 });
	}

	const projectId = params.id!;

	// Fired together — none of these depend on the one before it, and RLS scopes each
	// to the caller's project membership, so a non-member ends up with an empty archive
	// rather than a leak.
	const [
		{ data: project, error: projectError },
		{ data: folderRows },
		{ data: fileRows },
		{ data: taskRows },
		{ data: bomRows },
		{ data: transactionRows },
		{ data: memberRows },
		{ data: ghostRows },
	] = await Promise.all([
		locals.supabase
			.from('projects')
			.select('id, name, description, currency, created_at, updated_at, owner_id')
			.eq('id', projectId)
			.single(),
		locals.supabase
			.from('folders')
			.select('id, name, parent_folder_id')
			.eq('project_id', projectId)
			.is('deleted_at', null),
		locals.supabase
			.from('files')
			.select('id, filename, folder_id, r2_key, size_bytes, mime_type, is_journal, created_at')
			.eq('project_id', projectId)
			.is('deleted_at', null)
			.is('uploader_deleted_at', null),
		locals.supabase
			.from('tasks')
			.select(TASK_COLUMNS)
			.eq('project_id', projectId)
			.is('deleted_at', null)
			.order('deadline', { ascending: true })
			.order('deadline_time', { ascending: true })
			.order('name', { ascending: true })
			.overrideTypes<RawTaskRow[]>(),
		locals.supabase
			.from('bom_items')
			.select('id, part_name, category, description, quantity, unit, unit_cost, supplier, item_url, total_cost')
			.eq('project_id', projectId)
			.is('deleted_at', null)
			.order('category', { ascending: true })
			.order('part_name', { ascending: true }),
		locals.supabase
			.from('transactions')
			.select(TRANSACTION_COLUMNS)
			.eq('project_id', projectId)
			.is('deleted_at', null)
			.order('transaction_date', { ascending: true }),
		locals.supabase
			.from('project_members')
			.select('role, is_auditor, contribution_percent, joined_at, user_id, profiles(display_name, email)')
			.eq('project_id', projectId)
			.overrideTypes<{ role: string; is_auditor: boolean; contribution_percent: number | null; joined_at: string; user_id: string; profiles: { display_name: string; email: string } | null }[]>(),
		locals.supabase
			.from('ghost_members')
			.select(GHOST_COLUMNS)
			.eq('project_id', projectId)
			.order('created_at', { ascending: true }),
	]);

	if (projectError || !project) {
		return new Response('Project not found', { status: 404 });
	}

	// Build folder id → posix path so the archive mirrors the tree the Files page
	// renders. A missing parent (should never happen — parent_folder_id cascades)
	// grounds out at the root, keeping the file visible instead of dropping it.
	const folderById = new Map((folderRows ?? []).map((f) => [f.id, f]));
	const pathCache = new Map<string, string>();
	function folderPath(id: string | null): string {
		if (!id) return '';
		const cached = pathCache.get(id);
		if (cached !== undefined) return cached;
		const folder = folderById.get(id);
		if (!folder) return '';
		const parent = folderPath(folder.parent_folder_id);
		const path = parent ? `${parent}/${safeName(folder.name)}` : safeName(folder.name);
		pathCache.set(id, path);
		return path;
	}

	// Refuse an archive we already know we can't fit in the isolate before spending
	// a round trip on every R2 object.
	const totalFileBytes = (fileRows ?? []).reduce((sum, f) => sum + (f.size_bytes ?? 0), 0);
	if (totalFileBytes > MAX_DOWNLOAD_BYTES) {
		return new Response(
			`This project's files total ${totalFileBytes.toLocaleString()} B, past the ${MAX_DOWNLOAD_BYTES.toLocaleString()} B cap for a single download.`,
			{ status: 413 },
		);
	}

	// Read every file's bytes in parallel through the R2 binding — same path as
	// files/[fileId]/raw.ts, one Worker invocation per object, no SigV4 signing.
	const takenByFolder = new Map<string, Set<string>>();
	const fileEntries: (ZipEntry | null)[] = await Promise.all(
		(fileRows ?? []).map(async (file) => {
			const object = await env.R2_BUCKET!.get(file.r2_key);
			if (!object) return null;
			const bytes = new Uint8Array(await object.arrayBuffer());
			const dir = folderPath(file.folder_id);
			const taken = takenByFolder.get(dir) ?? new Set<string>();
			takenByFolder.set(dir, taken);
			const name = dedupe(taken, safeName(file.filename));
			return { name: `files/${dir ? `${dir}/` : ''}${name}`, bytes };
		}),
	);

	const memberById = new Map((memberRows ?? []).map((m) => [m.user_id, m.profiles?.display_name ?? '']));
	const ghostById = new Map((ghostRows ?? []).map((g) => [g.id, g.display_name]));

	// Same shape as TasksTable.svelte's downloadTasks — one export format across the
	// app, so a reader who's seen a per-page export knows what this one holds too.
	const tasksPayload = {
		project: project.name,
		exportedAt: new Date().toISOString(),
		taskCount: (taskRows ?? []).length,
		tasks: (taskRows ?? []).map(normalizeTask).map((task) => ({
			id: task.id,
			name: task.name,
			category: task.category,
			description: task.description,
			startDate: task.start_date,
			startTime: task.start_time,
			deadline: task.deadline,
			deadlineTime: task.deadline_time,
			status: task.status,
			assignees: task.assignees.map((a) => a.display_name),
		})),
	};

	const membersPayload = {
		project: project.name,
		exportedAt: new Date().toISOString(),
		members: (memberRows ?? []).map((m) => ({
			displayName: m.profiles?.display_name ?? null,
			email: m.profiles?.email ?? null,
			role: m.role,
			isAuditor: m.is_auditor,
			contributionPercent: m.contribution_percent,
			joinedAt: m.joined_at,
		})),
		ghostMembers: (ghostRows ?? []).map((g) => ({
			displayName: g.display_name,
			note: g.note,
			contributionPercent: g.contribution_percent,
			isDeletedAccount: g.is_deleted_account,
		})),
	};

	const bomPayload = {
		project: project.name,
		currency: project.currency,
		exportedAt: new Date().toISOString(),
		items: (bomRows ?? []).map((b) => ({
			partName: b.part_name,
			category: b.category,
			description: b.description,
			quantity: b.quantity,
			unit: b.unit,
			unitCost: b.unit_cost,
			supplier: b.supplier,
			itemUrl: b.item_url,
			totalCost: b.total_cost,
		})),
	};

	// Party columns folded into a single readable name — the payer/payee id-space
	// (see lib/money-parties.ts) is an internal detail, and an exported record
	// should read on its own without a lookup table.
	function partyName(memberId: string | null, ghostId: string | null): string | null {
		if (memberId) return memberById.get(memberId) ?? null;
		if (ghostId) return ghostById.get(ghostId) ?? null;
		return null;
	}

	const transactionsPayload = {
		project: project.name,
		currency: project.currency,
		exportedAt: new Date().toISOString(),
		transactions: (transactionRows ?? []).map((t: any) => ({
			id: t.id,
			date: t.transaction_date,
			type: t.type,
			itemName: t.item_name,
			quantity: t.quantity,
			unit: t.unit,
			unitCost: t.unit_cost,
			supplier: t.supplier,
			itemUrl: t.item_url,
			totalCost: t.total_cost,
			paidBy: partyName(t.member_id, t.ghost_member_id),
			paidTo: partyName(t.related_member_id, t.related_ghost_member_id),
			// Lines carry the parent's id here; a bulk parent's own row has this null.
			// The reader can group on it to reconstruct the parent → lines shape.
			groupId: t.group_id,
		})),
	};

	const readme = [
		`Project: ${project.name}`,
		project.description ? `\nDescription:\n${project.description}` : '',
		`\nCurrency: ${project.currency}`,
		`Created: ${project.created_at}`,
		`Exported: ${new Date().toISOString()}`,
		'',
		'Contents:',
		'  README.txt              — this file',
		'  files/…                 — project files, mirroring the Files-page folder tree',
		'  tasks.json              — tasks with categories, deadlines, assignees',
		'  bom.json                — bill of materials',
		'  transactions.json       — money transactions (parent rows and their lines)',
		'  members.json            — real members and ghost members with contribution %',
		'',
	].join('\n');

	const entries: ZipEntry[] = [
		textEntry('README.txt', readme),
		jsonEntry('tasks.json', tasksPayload),
		jsonEntry('bom.json', bomPayload),
		jsonEntry('transactions.json', transactionsPayload),
		jsonEntry('members.json', membersPayload),
		...fileEntries.filter((e): e is ZipEntry => e !== null),
	];

	const bytes = zip(entries);
	const safeProjectName = safeName(project.name);

	return new Response(bytes.buffer as ArrayBuffer, {
		headers: {
			'content-type': 'application/zip',
			'content-length': String(bytes.length),
			'content-disposition': `attachment; filename="${safeProjectName}.zip"`,
			'cache-control': 'private, no-store',
		},
	});
};
