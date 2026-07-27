// Task category colours. Ten fixed slots, defined per theme in tokens.css as
// `--color-cat-N` / `--color-cat-N-fg` — what's stored anywhere is the *index*, never
// a hex value, so a category keeps its identity across a theme switch instead of
// staying coloured for the palette it was picked under.
//
// A category has a colour whether or not anyone has picked one: an unpicked category
// falls back to a hash of its own name, so the list bands and the calendar popsicles
// are never all one colour on a project that has never touched the picker. Picking a
// swatch writes a `task_categories` row that overrides the fallback from then on.

export const CATEGORY_COLOR_COUNT = 10;

// name -> color_index, for the categories somebody has actually picked a colour for.
// Keyed by the trimmed category text, the same key the list groups by.
export type CategoryColors = Record<string, number>;

export function isCategoryColorIndex(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value < CATEGORY_COLOR_COUNT;
}

// FNV-1a over the name. Any stable hash would do; what matters is that it's computed
// the same way on the server and the client (so SSR and hydration agree) and that it
// doesn't move when the task list does — the colour belongs to the category, not to
// its position in a list that re-sorts on every edit.
export function autoColorIndex(name: string): number {
	let hash = 2166136261;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % CATEGORY_COLOR_COUNT;
}

// null for an uncategorized task — it has no category to colour, and the callers
// fall back to the neutral surface rather than to slot 0.
export function categoryColorIndex(category: string | null | undefined, colors: CategoryColors): number | null {
	const name = category?.trim();
	if (!name) return null;

	// Object.hasOwn rather than `colors[name] ?? auto`: the key is user-typed free
	// text, so a category literally named `constructor` would otherwise resolve to a
	// function off Object.prototype and sail past the ?? — the same trap languageFor()
	// in file-kind.ts avoids.
	if (Object.hasOwn(colors, name) && isCategoryColorIndex(colors[name])) return colors[name];
	return autoColorIndex(name);
}

// The two custom properties a coloured surface reads, as an inline `style` value.
// Every consumer writes `background: var(--cat-bg, <neutral>)`, so returning '' for an
// uncategorized item is what makes it fall back — no second code path.
export function categoryColorStyle(index: number | null): string {
	if (index === null) return '';
	return `--cat-bg: var(--color-cat-${index}); --cat-fg: var(--color-cat-${index}-fg);`;
}

export function categoryStyle(category: string | null | undefined, colors: CategoryColors): string {
	return categoryColorStyle(categoryColorIndex(category, colors));
}

// 0..9, for rendering the swatch row.
export const CATEGORY_COLOR_SLOTS = Array.from({ length: CATEGORY_COLOR_COUNT }, (_, i) => i);
