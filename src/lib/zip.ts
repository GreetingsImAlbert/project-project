// Minimal in-memory ZIP writer. Entries are STORED (uncompressed): a valid ZIP
// doesn't have to be deflated, and the two callers — buildXlsx and the project
// "download all" endpoint — either ship text so small compression is noise or
// ship files that are already compressed (CAD, PDFs, images). Skipping deflate
// keeps this tens of lines instead of hundreds, and avoids pulling a compression
// library into the Worker bundle.

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
	name: string;
	bytes: Uint8Array;
}

// A fixed timestamp rather than `new Date()`: the same table exported twice
// should produce byte-identical files, which makes "did this actually change?"
// answerable by diffing. 1980-01-01 00:00 is the DOS epoch, the lowest value
// the format can hold.
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

export function zip(entries: ZipEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const crc = crc32(entry.bytes);
		const size = entry.bytes.length;

		const local = new Uint8Array(30 + nameBytes.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true); // version needed
		localView.setUint16(6, 0x0800, true); // UTF-8 names
		localView.setUint16(8, 0, true); // stored, no compression
		localView.setUint16(10, DOS_TIME, true);
		localView.setUint16(12, DOS_DATE, true);
		localView.setUint32(14, crc, true);
		localView.setUint32(18, size, true); // compressed size == uncompressed
		localView.setUint32(22, size, true);
		localView.setUint16(26, nameBytes.length, true);
		localView.setUint16(28, 0, true); // no extra field
		local.set(nameBytes, 30);

		locals.push(local, entry.bytes);

		const central = new Uint8Array(46 + nameBytes.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true); // version made by
		centralView.setUint16(6, 20, true); // version needed
		centralView.setUint16(8, 0x0800, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint16(12, DOS_TIME, true);
		centralView.setUint16(14, DOS_DATE, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, size, true);
		centralView.setUint32(24, size, true);
		centralView.setUint16(28, nameBytes.length, true);
		centralView.setUint16(30, 0, true); // extra
		centralView.setUint16(32, 0, true); // comment
		centralView.setUint16(34, 0, true); // disk number
		centralView.setUint16(36, 0, true); // internal attrs
		centralView.setUint32(38, 0, true); // external attrs
		centralView.setUint32(42, offset, true);
		central.set(nameBytes, 46);

		centrals.push(central);
		offset += local.length + size;
	}

	const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);

	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(4, 0, true); // this disk
	endView.setUint16(6, 0, true); // disk with central directory
	endView.setUint16(8, entries.length, true);
	endView.setUint16(10, entries.length, true);
	endView.setUint32(12, centralSize, true);
	endView.setUint32(16, offset, true);
	endView.setUint16(20, 0, true); // no comment

	const parts = [...locals, ...centrals, end];
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const part of parts) {
		out.set(part, cursor);
		cursor += part.length;
	}
	return out;
}
