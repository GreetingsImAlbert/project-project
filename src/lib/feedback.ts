export type FeedbackKind = 'help' | 'suggestion';

export interface FeedbackInput {
	message?: unknown;
	path?: unknown;
	kind?: unknown;
}

export interface ParsedFeedbackInput {
	message: string;
	path: string | null;
	kind: FeedbackKind;
}

// The API accepts the original Help payload without a kind for backwards
// compatibility, but every stored feedback report gets an explicit kind.
export function parseFeedbackInput(input: unknown): ParsedFeedbackInput | null {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

	const body = input as FeedbackInput;
	const message = typeof body.message === 'string' ? body.message.trim() : '';
	if (!message) return null;

	const kind = body.kind === undefined ? 'help' : body.kind;
	if (kind !== 'help' && kind !== 'suggestion') return null;

	return {
		message,
		path: typeof body.path === 'string' ? body.path : null,
		kind,
	};
}

export function feedbackKindFromContext(context: unknown): FeedbackKind | null {
	if (!context || typeof context !== 'object' || Array.isArray(context)) return null;

	const kind = (context as Record<string, unknown>).feedbackKind;
	return kind === 'help' || kind === 'suggestion' ? kind : null;
}
