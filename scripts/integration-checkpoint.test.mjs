import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
	findExistingUpload,
	parseArgs,
	parseUploadResult,
	readVerifiedManifest,
} from './integration-checkpoint.mjs';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'flue-checkpoint-test-'));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

test('parses checkpoint modes and rejects unknown arguments', () => {
	assert.deepEqual(parseArgs(['--', '--dry-run']), { dryRun: true, showHelp: false });
	assert.deepEqual(parseArgs(['--help']), { dryRun: false, showHelp: true });
	assert.throws(() => parseArgs(['--publish']), /Unknown argument/);
});

test('selects only an upload with the exact filename and digest', () => {
	const file = { path: '/tmp/flue-runtime.tgz', sha256: 'expected' };
	const upload = findExistingUpload(
		[
			{ filename: 'flue-runtime.tgz', contentHash: 'other', createdAt: '2026-01-02' },
			{
				filename: 'flue-runtime.tgz',
				contentHash: 'expected',
				createdAt: '2026-01-01',
				url: 'https://example.test/exact',
			},
		],
		file,
	);
	assert.equal(upload?.url, 'https://example.test/exact');
});

test('validates the upload response identity', () => {
	const file = { path: '/tmp/flue-runtime.tgz', sha256: 'expected' };
	const response = JSON.stringify({
		uploads: [
			{ filename: 'flue-runtime.tgz', sha256: 'expected', url: 'https://example.test/file' },
		],
	});
	assert.equal(parseUploadResult(response, file).url, 'https://example.test/file');
	assert.throws(
		() => parseUploadResult(response.replace('expected', 'other'), file),
		/did not match/,
	);
});

test('reuses only a complete fresh-consumer-verified current manifest', () => {
	const sourceCommit = 'a'.repeat(40);
	const sourceTree = 'b'.repeat(40);
	const version = '2.1.0-samva.test';
	const digests = {
		runtime: 'd92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23',
		sdk: 'a9d0df1873a041a6e38e2c461ffc6b53d216fd7cfab9bece3e9b5bc5c69b4203',
		react: '275976081ce1abf67779eb3c388b5e14531082e52137502e264776e1a6a11595',
		vite: 'b16efac145e9242cfb05d739a8509ac7295f381108dce0f753e52a1aaf48e7a1',
	};
	const artifacts = ['runtime', 'sdk', 'react', 'vite'].map((name) => {
		const path = join(temporaryDirectory, `${name}.tgz`);
		writeFileSync(path, name);
		return { name: `@flue/${name}`, version, path, sha256: digests[name] };
	});
	const manifestPath = join(temporaryDirectory, 'manifest.json');
	const manifest = {
		schemaVersion: 1,
		sourceCommit,
		sourceTree,
		version,
		verification: { freshConsumer: true },
		artifacts,
	};
	writeFileSync(manifestPath, JSON.stringify(manifest));
	assert.equal(readVerifiedManifest(manifestPath, sourceCommit, sourceTree)?.version, version);
	writeFileSync(manifestPath, JSON.stringify({ ...manifest, verification: undefined }));
	assert.equal(readVerifiedManifest(manifestPath, sourceCommit, sourceTree), undefined);
});
