import type { SupabaseClient } from '@supabase/supabase-js';

/** The public sections are ordered the same way they appear in project nav. */
export const PUBLIC_SECTIONS = ['overview', 'tasks', 'files', 'journal', 'money'] as const;

export type PublicSection = (typeof PUBLIC_SECTIONS)[number];

/**
 * This is an allowlist, not a column name supplied by a request. Keep all
 * database-column choices here so visibility endpoints cannot be turned into
 * arbitrary project updates.
 */
export const PUBLIC_SECTION_COLUMNS: Readonly<Record<PublicSection, PublicSectionColumn>> = {
	overview: 'is_public',
	tasks: 'public_tasks_enabled',
	files: 'public_files_enabled',
	journal: 'public_journal_enabled',
	money: 'public_money_enabled',
};

export type PublicSectionColumn =
	| 'is_public'
	| 'public_tasks_enabled'
	| 'public_files_enabled'
	| 'public_journal_enabled'
	| 'public_money_enabled';

/**
 * PostgREST's `.or()` syntax is intentionally kept beside the section map.
 * It is used for discovery only; individual page gates still check one
 * section after fetching the complete safe row.
 */
export const PUBLIC_PROJECT_DISCOVERY_FILTER =
	'is_public.eq.true,public_tasks_enabled.eq.true,public_files_enabled.eq.true,public_journal_enabled.eq.true,public_money_enabled.eq.true';

export const PUBLIC_PROJECT_COLUMNS =
	'id, name, is_public, public_tasks_enabled, public_files_enabled, public_journal_enabled, public_money_enabled';

export interface PublicProjectGate {
	id: string;
	name: string;
	is_public: boolean;
	public_tasks_enabled: boolean;
	public_files_enabled: boolean;
	public_journal_enabled: boolean;
	public_money_enabled: boolean;
}

export interface PublicNavigationProject {
	id: string;
	name: string;
	section: PublicSection;
	href: string;
}

export function isPublicSection(value: unknown): value is PublicSection {
	return typeof value === 'string' && (PUBLIC_SECTIONS as readonly string[]).includes(value);
}

export function isPublicSectionEnabled(project: PublicProjectGate, section: PublicSection): boolean {
	return project[PUBLIC_SECTION_COLUMNS[section]];
}

export function isPublicProject(project: PublicProjectGate): boolean {
	return PUBLIC_SECTIONS.some((section) => isPublicSectionEnabled(project, section));
}

/** Return the first enabled section, or null for a private project. */
export function publicProjectLandingSection(project: PublicProjectGate): PublicSection | null {
	return PUBLIC_SECTIONS.find((section) => isPublicSectionEnabled(project, section)) ?? null;
}

export function publicProjectPath(projectId: string, section: PublicSection): string {
	return section === 'overview' ? `/projects/${projectId}` : `/projects/${projectId}/${section}`;
}

export function publicProjectLandingPath(project: PublicProjectGate): string | null {
	const section = publicProjectLandingSection(project);
	return section ? publicProjectPath(project.id, section) : null;
}

export function toPublicNavigationProject(project: PublicProjectGate): PublicNavigationProject | null {
	const section = publicProjectLandingSection(project);
	if (!section) return null;
	return {
		id: project.id,
		name: project.name,
		section,
		href: publicProjectPath(project.id, section),
	};
}

/**
 * Read the public boundary with the service-role client. This helper is for
 * the outsider branch only: callers should first try their normal RLS-scoped
 * member query and invoke this after that query found no project.
 *
 * Errors intentionally collapse to null, preserving the app's indistinguishable
 * 404 for a missing project, a private section, and an unavailable public row.
 */
export async function getPublicProjectGate(
	admin: SupabaseClient,
	projectId: string | undefined,
	section: PublicSection,
): Promise<PublicProjectGate | null> {
	if (!projectId) return null;

	const { data, error } = await admin
		.from('projects')
		.select(PUBLIC_PROJECT_COLUMNS)
		.eq('id', projectId)
		.maybeSingle()
		.overrideTypes<PublicProjectGate>();

	if (error || !data || !isPublicSectionEnabled(data, section)) return null;
	return data;
}
