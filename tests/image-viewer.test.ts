import assert from 'node:assert/strict';
import test from 'node:test';
import {
	binaryPreviewInfo,
	fileKind,
	imageMimeType,
	MAX_IMAGE_BYTES,
} from '../src/lib/file-kind.ts';

const browserImageTypes = [
	['photo.jpg', 'image/jpeg'],
	['photo.jpeg', 'image/jpeg'],
	['photo.png', 'image/png'],
	['animation.gif', 'image/gif'],
	['render.webp', 'image/webp'],
	['render.avif', 'image/avif'],
	['scan.bmp', 'image/bmp'],
	['favicon.ico', 'image/x-icon'],
] as const;

test('classifies the supported browser image formats', () => {
	for (const [filename, contentType] of browserImageTypes) {
		assert.equal(fileKind(filename), 'image', filename);
		assert.equal(imageMimeType(filename), contentType, filename);
	}
});

test('image classification is case-insensitive and handles compound names', () => {
	assert.equal(fileKind('  assembly.preview.PNG  '), 'image');
	assert.equal(imageMimeType('  assembly.preview.PNG  '), 'image/png');
});

test('binary preview policy supplies the endpoint MIME type and image ceiling', () => {
	assert.deepEqual(binaryPreviewInfo('drawing.JPEG'), {
		kind: 'image',
		maxBytes: MAX_IMAGE_BYTES,
		label: 'Image',
		contentType: 'image/jpeg',
	});
	assert.equal(binaryPreviewInfo('drawing.JPEG')?.maxBytes, 50_000_000);
});

test('binary preview policy still covers PDF and CAD files', () => {
	assert.deepEqual(binaryPreviewInfo('manual.pdf'), {
		kind: 'pdf',
		maxBytes: 50_000_000,
		label: 'PDF',
		contentType: 'application/pdf',
	});
	assert.deepEqual(binaryPreviewInfo('part.stl'), {
		kind: 'model',
		maxBytes: 50_000_000,
		label: 'Model',
		contentType: 'application/octet-stream',
	});
});

test('non-previewable image MIME extensions stay out of the binary endpoint', () => {
	assert.equal(fileKind('illustration.svg'), 'text');
	assert.equal(binaryPreviewInfo('illustration.svg'), null);
	assert.equal(fileKind('scan.tiff'), 'unsupported');
	assert.equal(binaryPreviewInfo('scan.tiff'), null);
	assert.equal(binaryPreviewInfo('notes.txt'), null);
});
