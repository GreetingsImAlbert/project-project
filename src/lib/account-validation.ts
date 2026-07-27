// Shared between the account page's two islands and the endpoints behind them, so
// the message a field shows before submitting is the same one the server would
// have sent back. The server checks are the real ones — the client copies exist
// only to save a round trip.

export const MIN_PASSWORD_LENGTH = 8;

// bcrypt only hashes the first 72 bytes and GoTrue rejects anything longer rather
// than silently truncating, so catch it here with a message that says why.
export const MAX_PASSWORD_LENGTH = 72;

export const MAX_DISPLAY_NAME_LENGTH = 60;

export function passwordProblem(password: string): string | null {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
	}

	if (password.length > MAX_PASSWORD_LENGTH) {
		return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
	}

	return null;
}

export function displayNameProblem(displayName: string): string | null {
	if (!displayName) {
		return 'Display name cannot be empty';
	}

	if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
		return `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`;
	}

	return null;
}
