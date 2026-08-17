import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseJournalEntries } from '../src/lib/journal-entries.ts';
import { toPublicTasks } from '../src/lib/public-project-dto.ts';
import type { Task } from '../src/lib/task-columns.ts';

function source(path: string): string {
	return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('public task DTO keeps display data while removing internal assignee IDs', () => {
	const task: Task = {
		id: 'task-1',
		name: 'Publish',
		category: 'Release',
		priority_position: 0,
		description: null,
		start_date: null,
		start_time: '00:00',
		deadline: null,
		deadline_time: '23:59',
		status: 'ongoing',
		assignees: [{
			id: 'assignee-secret',
			user_id: 'user-secret',
			ghost_member_id: 'ghost-secret',
			display_name: 'Visible teammate',
			avatar: 'dot',
		}],
	};
	const [publicTask] = toPublicTasks([task]);
	assert.equal(publicTask.assignees[0].display_name, 'Visible teammate');
	assert.equal(publicTask.assignees[0].avatar, 'dot');
	assert.equal(publicTask.assignees[0].user_id, null);
	assert.equal(publicTask.assignees[0].ghost_member_id, null);
	assert.notEqual(publicTask.assignees[0].id, 'assignee-secret');

	const tasksPage = source('../src/pages/projects/[id]/tasks.astro');
	const publicBranch = tasksPage.slice(tasksPage.indexOf('if (!project) {'));
	assert.match(publicBranch, /\.is\('deleted_at', null\)/);
	assert.doesNotMatch(publicBranch, /email/);
	assert.match(publicBranch, /toPublicTasks\(tasks\)/);
});

test('public journal reads finalized, non-deleted history only', () => {
	const content = 'draft text that has no finalized heading\n## 2026-08-10\n\nFinal note';
	assert.deepEqual(parseJournalEntries(content), [{ date: '2026-08-10', body: 'Final note' }]);

	const journalPage = source('../src/pages/projects/[id]/journal.astro');
	const publicBranch = journalPage.slice(journalPage.indexOf('if (!project) {'));
	assert.match(journalPage, /\.eq\('is_journal', true\)/);
	assert.match(journalPage, /\.is\('deleted_at', null\)/);
	assert.match(publicBranch, /readOnly = true/);
	assert.doesNotMatch(publicBranch, /ensureJournal(File|Draft)/);
	assert.doesNotMatch(publicBranch, /journal_drafts/);
	assert.match(source('../src/components/JournalHistory.svelte'), /No finalized journal entries yet/);
});

test('public Money payload excludes personal summary inputs and deleted rows', () => {
	const moneyPage = source('../src/pages/projects/[id]/money.astro');
	const publicBranch = moneyPage.slice(moneyPage.indexOf('if (!project) {'));
	assert.doesNotMatch(publicBranch, /email/);
	assert.match(publicBranch, /\.eq\('is_deleted_account', false\)/);
	assert.ok((publicBranch.match(/\.is\('deleted_at', null\)/g) ?? []).length >= 2);
	assert.match(moneyPage, /currentUserId=\{publicReader \? null :/);

	const summary = source('../src/components/MoneySummary.svelte');
	assert.match(summary, /currentUserId: string \| null/);
	assert.match(summary, /\{#if currentUserId\}/);
	assert.match(summary, /Your share/);
	assert.match(summary, /You owe/);
});

test('public route access matrix keeps flag-off reads at 404 and members role-aware', () => {
	const routes = [
		['tasks', '../src/pages/projects/[id]/tasks.astro'],
		['journal', '../src/pages/projects/[id]/journal.astro'],
		['money', '../src/pages/projects/[id]/money.astro'],
	] as const;
	for (const [section, path] of routes) {
		const page = source(path);
		const publicBranch = page.slice(page.indexOf('if (!project) {'));
		assert.match(publicBranch, new RegExp(`getPublicProjectGate\\(admin, id, '${section}'\\)`));
		assert.match(publicBranch, /status: 404/);
		assert.match(publicBranch, /publicReader = true|readOnly = true/);
		assert.doesNotMatch(publicBranch, /Astro\.redirect/);
		assert.match(page, /const user = Astro\.locals\.user/);
	}

	const journal = source('../src/pages/projects/[id]/journal.astro');
	assert.match(journal, /loadProjectJournals\(admin, env, project\.id, user\.id\)/);
	assert.match(journal, /userRole === 'owner' \|\| userRole === 'editor'/);
	assert.doesNotMatch(journal, /Astro\.redirect\(`\/projects\/\$\{project\.id\}`\)/);

	const overview = source('../src/pages/projects/[id].astro');
	assert.match(overview, /rpc\('public_project_get'/);
	assert.match(overview, /status: 404/);
	assert.match(overview, /const readOnly = publicProject !== null/);
});

test('write APIs require authentication and project membership/editor rights', () => {
	const writeApis = [
		'../src/pages/api/projects/[id]/tasks/create.ts',
		'../src/pages/api/tasks/[taskId]/update.ts',
		'../src/pages/api/tasks/[taskId]/delete.ts',
		'../src/pages/api/projects/[id]/bom/create.ts',
		'../src/pages/api/projects/[id]/transactions/create.ts',
		'../src/pages/api/projects/[id]/journal/draft.ts',
	];
	for (const path of writeApis) {
		const api = source(path);
		assert.match(api, /if \(!locals\.user\)/, path);
		assert.match(api, /Unauthorized/, path);
		assert.match(api, /Forbidden|canEditMoney|project_members/, path);
	}
});
