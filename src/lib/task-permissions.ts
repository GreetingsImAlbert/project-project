// Task priority is a general project edit, so only owners and editors may persist
// it. Keeping this predicate shared prevents the API routes from drifting apart.
export function canEditTasks(role: unknown): boolean {
	return role === 'owner' || role === 'editor';
}
