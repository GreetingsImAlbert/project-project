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
// An .xlsx is a ZIP of XML parts (see lib/zip.ts for the packaging). Strings are
// written inline (`t="inlineStr"`) instead of into a shared string table, which
// drops a whole part and the bookkeeping that goes with it.

import { zip, type ZipEntry } from './zip';

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
