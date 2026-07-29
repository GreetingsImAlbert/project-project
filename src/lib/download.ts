// Client-side file downloads. The Files page hands the browser a presigned R2 URL and
// lets it navigate (see FileViewerPanel), but these exports are built in the page from
// data that's already in the store, so there's nothing to fetch — the bytes go straight
// from a Blob to the user's disk.

// Everything Windows, macOS and Linux disagree about, replaced rather than dropped so
// two differently-named projects can't collapse onto the same filename. Project names
// reach this, so it has to be total.
function safeFilePart(raw: string): string {
	const cleaned = raw
		.replace(/[<>:"/\\|?*]/g, '-')
		// Control characters are legal in a Blob filename but not in a file name on disk.
		.split('')
		.filter((ch) => ch.codePointAt(0)! >= 0x20)
		.join('')
		.replace(/\s+/g, ' ')
		// A trailing dot or space is silently stripped by Windows, which turns
		// 'Project .xlsx' into something the browser and the disk disagree about.
		.replace(/^[\s.]+|[\s.]+$/g, '');

	return cleaned || 'project';
}

// '<project> — tasks.json'. The em dash matches how the app writes page titles.
export function exportFilename(projectName: string, label: string, extension: string): string {
	return `${safeFilePart(projectName)} - ${label}.${extension}`;
}

export function downloadBlob(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	// Firefox only fires the download for an anchor that's actually in the document.
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	// Same turn would race the download in Safari; one frame is enough for every
	// browser to have taken its copy of the blob.
	requestAnimationFrame(() => URL.revokeObjectURL(url));
}

export function downloadJson(filename: string, data: unknown): void {
	// Two-space indent and a trailing newline — this is meant to be opened and read,
	// not just parsed.
	const text = `${JSON.stringify(data, null, 2)}\n`;
	downloadBlob(filename, new Blob([text], { type: 'application/json' }));
}
