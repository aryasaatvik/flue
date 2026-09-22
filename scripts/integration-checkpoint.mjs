import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedPackages = ['@flue/runtime', '@flue/sdk', '@flue/react', '@flue/vite'];

const help = `Publish a verified Flue integration checkpoint to Scratchpad.

Usage:
  pnpm checkpoint:integration -- --dry-run
  pnpm checkpoint:integration

The command requires a clean Git worktree and a fresh-consumer-verified package
set. It reuses a verified manifest for the current commit and tree when possible,
then reuses existing uploads with the same filename and SHA-256. A non-dry run
uploads missing files with the Scratchpad production profile and reads them back.
`;

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: 'utf8',
		stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
	});
}

function sha256(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function parseArgs(args) {
	const normalized = args.filter((argument) => argument !== '--');
	const unknown = normalized.filter(
		(argument) => !['--dry-run', '--help', '-h'].includes(argument),
	);
	if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
	return {
		dryRun: normalized.includes('--dry-run'),
		showHelp: normalized.includes('--help') || normalized.includes('-h'),
	};
}

export function findExistingUpload(uploads, file) {
	return uploads
		.filter(
			(upload) => upload.filename === basename(file.path) && upload.contentHash === file.sha256,
		)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function parseUploadResult(output, file) {
	const response = JSON.parse(output);
	const uploaded = response.uploads?.[0];
	if (
		response.uploads?.length !== 1 ||
		uploaded?.filename !== basename(file.path) ||
		uploaded.sha256 !== file.sha256 ||
		typeof uploaded.url !== 'string'
	) {
		throw new Error(`Scratchpad upload response did not match ${basename(file.path)}.`);
	}
	return uploaded;
}

export function readVerifiedManifest(manifestPath, sourceCommit, sourceTree) {
	if (!existsSync(manifestPath)) return undefined;
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (
		manifest.schemaVersion !== 1 ||
		manifest.sourceCommit !== sourceCommit ||
		manifest.sourceTree !== sourceTree ||
		manifest.verification?.freshConsumer !== true ||
		!Array.isArray(manifest.artifacts) ||
		manifest.artifacts.length !== expectedPackages.length ||
		!expectedPackages.every((name) => manifest.artifacts.some((artifact) => artifact.name === name))
	) {
		return undefined;
	}
	for (const artifact of manifest.artifacts) {
		if (
			artifact.version !== manifest.version ||
			!existsSync(artifact.path) ||
			sha256(artifact.path) !== artifact.sha256
		) {
			return undefined;
		}
	}
	return manifest;
}

function resolveManifest() {
	const sourceCommit = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
	const sourceTree = run('git', ['rev-parse', 'HEAD^{tree}'], { capture: true }).trim();
	const cachedPath = join(
		repositoryRoot,
		'artifacts',
		`flue-samva-${sourceCommit.slice(0, 12)}-manifest.json`,
	);
	const cached = readVerifiedManifest(cachedPath, sourceCommit, sourceTree);
	if (cached) {
		console.log(`Reused verified manifest ${cachedPath}`);
		return { manifest: cached, manifestPath: cachedPath };
	}

	const output = run('pnpm', ['run', 'pack:integration'], { capture: true });
	process.stdout.write(output);
	const manifestPath = /^Manifest (.+)$/m.exec(output)?.[1];
	if (!manifestPath) throw new Error('Integration packer did not report its manifest.');
	const manifest = readVerifiedManifest(manifestPath, sourceCommit, sourceTree);
	if (!manifest) throw new Error('Integration packer did not produce a verified current manifest.');
	return { manifest, manifestPath };
}

function listUploads() {
	return JSON.parse(
		run('scratchpad', ['uploads', 'list', '--profile', 'production', '--json'], {
			capture: true,
		}),
	);
}

function uploadFile(file) {
	const output = run('scratchpad', ['upload', '--profile', 'production', '--json', file.path], {
		capture: true,
	});
	return parseUploadResult(output, file);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.showHelp) {
		console.log(help);
		return;
	}
	if (run('git', ['status', '--porcelain'], { capture: true }).trim()) {
		throw new Error('Integration checkpoint requires a clean committed worktree.');
	}
	try {
		run('scratchpad', ['--version'], { capture: true });
	} catch {
		throw new Error('scratchpad is not installed; install it before checkpoint publication.');
	}

	const { manifest, manifestPath } = resolveManifest();
	const files = [
		...manifest.artifacts.map((artifact) => ({
			path: artifact.path,
			sha256: artifact.sha256,
		})),
		{ path: manifestPath, sha256: sha256(manifestPath) },
	];
	let uploads = listUploads();
	const receipt = [];
	for (const file of files) {
		const existing = findExistingUpload(uploads, file);
		if (existing) {
			console.log(`Scratchpad checkpoint already exists: ${existing.url}`);
			receipt.push({ ...file, url: existing.url });
			continue;
		}
		if (options.dryRun) {
			console.log(
				`Dry run: would upload ${file.path} sha256=${file.sha256} to Scratchpad profile production`,
			);
			continue;
		}
		const uploaded = uploadFile(file);
		console.log(`Scratchpad checkpoint: ${uploaded.url}`);
		receipt.push({ ...file, url: uploaded.url });
	}

	if (options.dryRun) return;
	files.forEach((file) => {
		if (!receipt.some((entry) => entry.path === file.path)) {
			throw new Error(`Checkpoint receipt omitted ${basename(file.path)}.`);
		}
	});
	// Read the production index back after all writes and verify the immutable identity.
	uploads = listUploads();
	for (const file of files) {
		const uploaded = findExistingUpload(uploads, file);
		if (!uploaded) throw new Error(`Scratchpad readback did not contain ${basename(file.path)}.`);
		console.log(`Verified ${basename(file.path)} sha256=${file.sha256} url=${uploaded.url}`);
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
