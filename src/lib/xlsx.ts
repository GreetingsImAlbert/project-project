// A minimal .xlsx writer — enough for the flat, one-header-row tables the Money page
// downloads, and nothing else.
//
// Written by hand rather than pulled from npm on purpose. The obvious candidate,
// SheetJS, hasn't published to the npm registry since 0.18.5 (it moved to its own CDN),
// so `npm i xlsx` installs a version with known advisories against it; exceljs is the
// other option and drags a pile of Node built-ins into a bundle that has to run on a
// Cloudflare Worker. What we actually need — strings, numbers, a bold header row and
// column widths — is a few hundred lines, so it lives here.
//
// An .xlsx is a ZIP of XML parts. Two shortcuts keep this small:
//   - entries are STORED (uncompressed). A valid ZIP doesn't have to be deflated, and
//     these files are tens of kilobytes of text that the user opens once.
//   - strings are written inline (`t="inlineStr"`) instead of into a shared string
//     table, which drops a whole part and the bookkeeping that goes with it.

export type CellValue = string | number | null | undefined;

export interface SheetColumn {
	header: string;
	// Approximate character width, as Excel counts it. Omitted means Excel's default.
	width?: number;
}

export interface Sheet {
	name: string;
	columns: SheetColumn[];
	rows: CellValue[][];
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

// The five characters Excel rejects in a sheet name, plus its 31-character cap. Callers
// pass human-written project names through here, so this has to be total, not a check.
export function sheetName(raw: string): string {
	const cleaned = raw.replace(/[[\]:*?/\\]/g, ' ').trim();
	return (cleaned || 'Sheet').slice(0, 31);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

// XML 1.0 forbids most control characters outright — no escape exists for them — and a
// stray one makes Excel reject the whole file. Tab/newline/carriage return are legal.
function stripInvalidXmlChars(value: string): string {
	let out = '';
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		// Tab, newline and carriage return are the only ones XML 1.0 lets through.
		if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
		out += ch;
	}
	return out;
}

// 0 -> A, 25 -> Z, 26 -> AA. Bijective base-26, so the usual divmod needs the -1.
function columnName(index: number): string {
	let name = '';
	let n = index;
	while (n >= 0) {
		name = String.fromCharCode(65 + (n % 26)) + name;
		n = Math.floor(n / 26) - 1;
	}
	return name;
}

// styleIndex maps into styles.xml's cellXfs below: 0 is plain, 1 is bold.
function cellXml(ref: string, value: CellValue, styleIndex: number): string {
	const style = styleIndex ? ` s="${styleIndex}"` : '';

	if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`;

	if (typeof value === 'number') {
		// NaN/Infinity have no SpreadsheetML representation — an empty cell beats a file
		// Excel won't open.
		if (!Number.isFinite(value)) return `<c r="${ref}"${style}/>`;
		return `<c r="${ref}"${style}><v>${value}</v></c>`;
	}

	const text = escapeXml(stripInvalidXmlChars(value));
	// xml:space="preserve" so leading/trailing spaces in a user's text survive.
	return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function rowXml(values: CellValue[], rowNumber: number, styleIndex: number): string {
	const cells = values.map((value, i) => cellXml(`${columnName(i)}${rowNumber}`, value, styleIndex)).join('');
	return `<row r="${rowNumber}">${cells}</row>`;
}

function worksheetXml(sheet: Sheet): string {
	const cols = sheet.columns
		.map((col, i) =>
			col.width ? `<col min="${i + 1}" max="${i + 1}" width="${col.width}" customWidth="1"/>` : '',
		)
		.join('');

	const header = rowXml(
		sheet.columns.map((c) => c.header),
		1,
		1,
	);
	const body = sheet.rows.map((row, i) => rowXml(row, i + 2, 0)).join('');

	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		`<worksheet xmlns="${NS_MAIN}">` +
		(cols ? `<cols>${cols}</cols>` : '') +
		`<sheetData>${header}${body}</sheetData>` +
		'</worksheet>'
	);
}

// Excel requires at least the two built-in fills (none, gray125) and one border, in
// that order, whether or not anything references them.
const STYLES_XML =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	`<styleSheet xmlns="${NS_MAIN}">` +
	'<fonts count="2">' +
	'<font><sz val="11"/><name val="Calibri"/></font>' +
	'<font><b/><sz val="11"/><name val="Calibri"/></font>' +
	'</fonts>' +
	'<fills count="2">' +
	'<fill><patternFill patternType="none"/></fill>' +
	'<fill><patternFill patternType="gray125"/></fill>' +
	'</fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="2">' +
	'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
	'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
	'</cellXfs>' +
	'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
	'</styleSheet>';

function workbookXml(sheets: Sheet[]): string {
	const entries = sheets
		.map((s, i) => `<sheet name="${escapeXml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
		.join('');

	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		`<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
		`<sheets>${entries}</sheets>` +
		'</workbook>'
	);
}

function workbookRelsXml(sheetCount: number): string {
	const sheetRels = Array.from(
		{ length: sheetCount },
		(_, i) =>
			`<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
	).join('');

	// styles takes the id after the sheets, so it can't collide with one of them.
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		`<Relationships xmlns="${NS_PKG_REL}">` +
		sheetRels +
		`<Relationship Id="rId${sheetCount + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
		'</Relationships>'
	);
}

function contentTypesXml(sheetCount: number): string {
	const sheetOverrides = Array.from(
		{ length: sheetCount },
		(_, i) =>
			`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
	).join('');

	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		`<Types xmlns="${NS_CT}">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
		sheetOverrides +
		'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
		'</Types>'
	);
}

const ROOT_RELS_XML =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	`<Relationships xmlns="${NS_PKG_REL}">` +
	`<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
	'</Relationships>';

/* ---------- ZIP ---------- */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
	name: string;
	bytes: Uint8Array;
}

// A fixed timestamp rather than `new Date()`: the same table exported twice should
// produce byte-identical files, which makes "did this actually change?" answerable by
// diffing. 1980-01-01 00:00 is the DOS epoch, the lowest value the format can hold.
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

function zip(entries: ZipEntry[]): Uint8Array {
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

export function buildXlsx(sheets: Sheet[]): Blob {
	if (sheets.length === 0) throw new Error('An xlsx needs at least one sheet');

	const encoder = new TextEncoder();
	const text = (name: string, xml: string): ZipEntry => ({ name, bytes: encoder.encode(xml) });

	const entries: ZipEntry[] = [
		text('[Content_Types].xml', contentTypesXml(sheets.length)),
		text('_rels/.rels', ROOT_RELS_XML),
		text('xl/workbook.xml', workbookXml(sheets)),
		text('xl/_rels/workbook.xml.rels', workbookRelsXml(sheets.length)),
		text('xl/styles.xml', STYLES_XML),
		...sheets.map((sheet, i) => text(`xl/worksheets/sheet${i + 1}.xml`, worksheetXml(sheet))),
	];

	// BlobPart wants a plain ArrayBuffer, and zip() always returns a Uint8Array over one
	// it allocated itself, so there's no SharedArrayBuffer case to worry about.
	return new Blob([zip(entries).buffer as ArrayBuffer], { type: XLSX_MIME });
}
