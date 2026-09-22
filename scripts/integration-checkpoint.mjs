import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv
	.slice(2)
	.filter((argument) => argument !== '--')
	.includes('--dry-run');
if (!dryRun) {
	throw new Error(
		'Checkpoint publication is intentionally disabled in this integration lane; run with --dry-run and provide the reported files to the authorized uploader.',
	);
}

const output = execFileSync('pnpm', ['run', 'pack:integration'], {
	cwd: repositoryRoot,
	encoding: 'utf8',
});
process.stdout.write(output);
const manifestPath = /^Manifest (.+)$/m.exec(output)?.[1];
if (!manifestPath) throw new Error('Integration packer did not report its manifest.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log('Dry run: proposed Scratchpad upload set');
for (const artifact of manifest.artifacts) {
	console.log(`${artifact.path} sha256=${artifact.sha256}`);
}
const manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
console.log(`${manifestPath} sha256=${manifestSha256}`);
