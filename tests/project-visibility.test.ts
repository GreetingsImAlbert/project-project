import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
	PUBLIC_PROJECT_COLUMNS,
	PUBLIC_PROJECT_DISCOVERY_FILTER,
	PUBLIC_SECTIONS,
	PUBLIC_SECTION_COLUMNS,
	isPublicProject,
	isPublicSection,
	parsePublicVisibilityRequest,
	publicProjectLandingPath,
	toPublicNavigationProject,
	toPublicSectionFlags,
	getPublicProjectGate,
	type PublicProjectGate,
} from '../src/lib/project-visibility.ts';

const project = (overrides: Partial<PublicProjectGate> = {}): PublicProjectGate => ({
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Public fixture',
	is_public: false,
	public_tasks_enabled: false,
	public_files_enabled: false,
	public_journal_enabled: false,
	public_money_enabled: false,
	...overrides,
});

test('visibility request parsing accepts only the five allowlisted sections', () => {
	for (const section of PUBLIC_SECTIONS) {
		assert.deepEqual(parsePublicVisibilityRequest({ section, enabled: true }), { section, enabled: true });
		assert.deepEqual(parsePublicVisibilityRequest({ section, enabled: false }), { section, enabled: false });
	}
	for (const invalid of [
		null,
		[],
		{},
		{ section: 'settings', enabled: true },
		{ section: 'is_public', enabled: true },
		{ section: 'tasks', enabled: 'true' },
		{ section: 'tasks', enabled: 1 },
	]) {
		assert.equal(parsePublicVisibilityRequest(invalid), null);
	}

	assert.deepEqual(Object.values(PUBLIC_SECTION_COLUMNS), [
		'is_public',
		'public_tasks_enabled',
		'public_files_enabled',
		'public_journal_enabled',
		'public_money_enabled',
	]);
});

test('discovery and landing logic use every flag in deterministic nav order', () => {
	const all = project({
		is_public: true,
		public_tasks_enabled: true,
		public_files_enabled: true,
		public_journal_enabled: true,
		public_money_enabled: true,
	});
	assert.equal(isPublicProject(all), true);
	assert.deepEqual(toPublicSectionFlags(all), {
		overview: true,
		tasks: true,
		files: true,
		journal: true,
		money: true,
	});
	assert.equal(toPublicNavigationProject(all)?.section, 'overview');
	assert.equal(toPublicNavigationProject(all)?.href, `/projects/${all.id}`);

	const onlySections = PUBLIC_SECTIONS.map((section) => {
		const flags = {
			is_public: section === 'overview',
			public_tasks_enabled: section === 'tasks',
			public_files_enabled: section === 'files',
			public_journal_enabled: section === 'journal',
			public_money_enabled: section === 'money',
		};
		const candidate = project(flags);
		return [section, publicProjectLandingPath(candidate), toPublicNavigationProject(candidate)?.section] as const;
	});
	assert.deepEqual(onlySections, PUBLIC_SECTIONS.map((section) => [
		section,
		section === 'overview' ? `/projects/${project().id}` : `/projects/${project().id}/${section}`,
		section,
	]));
	assert.equal(isPublicProject(project()), false);
	assert.equal(publicProjectLandingPath(project()), null);

	const discoveryColumns = PUBLIC_PROJECT_DISCOVERY_FILTER.split(',').map((term) => term.replace('.eq.true', ''));
	assert.deepEqual(discoveryColumns, Object.values(PUBLIC_SECTION_COLUMNS));
	assert.match(PUBLIC_PROJECT_COLUMNS, /public_tasks_enabled/);
	assert.match(PUBLIC_PROJECT_COLUMNS, /public_journal_enabled/);
	assert.match(PUBLIC_PROJECT_COLUMNS, /public_money_enabled/);
});

test('section requests never widen the allowlist through the visibility API', () => {
	const source = readFileSync(new URL('../src/pages/api/projects/[id]/visibility/index.ts', import.meta.url), 'utf8');
	assert.match(source, /parsePublicVisibilityRequest\(body\)/);
	assert.match(source, /PUBLIC_SECTION_COLUMNS\[section\]/);
	assert.doesNotMatch(source, /update\(\{\s*\[body\./);
	for (const section of PUBLIC_SECTIONS) assert.equal(isPublicSection(section), true);
	assert.equal(isPublicSection('settings'), false);
});

test('the public gate has the same 404 boundary for guests and non-members', async () => {
	const row = project({ public_tasks_enabled: true });
	const admin = {
		from: () => ({
			select: () => ({
				eq: () => ({
					maybeSingle: () => ({
						overrideTypes: async () => ({ data: row, error: null }),
					}),
				}),
			}),
		}),
	} as any;

	assert.equal((await getPublicProjectGate(admin, row.id, 'tasks'))?.id, row.id);
	assert.equal(await getPublicProjectGate(admin, row.id, 'journal'), null);
	assert.equal(await getPublicProjectGate(admin, undefined, 'tasks'), null);
});
