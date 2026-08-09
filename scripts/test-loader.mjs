import path from 'node:path';

// The app's Vite/Astro resolver permits extensionless local TypeScript imports;
// Node's native type stripping does not, so mirror that one resolver rule for the
// focused tests without changing production imports.
export async function resolve(specifier, context, defaultResolve) {
	if (specifier.startsWith('.') && !path.extname(specifier)) {
		try {
			return await defaultResolve(`${specifier}.ts`, context, defaultResolve);
		} catch {
			// Let Node produce its normal resolution error for non-TypeScript imports.
		}
	}

	return defaultResolve(specifier, context, defaultResolve);
}
