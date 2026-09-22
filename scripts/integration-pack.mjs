import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(repositoryRoot, 'artifacts');
const packageDirectories = ['runtime', 'sdk', 'react', 'vite'];
const packageNames = packageDirectories.map((name) => `@flue/${name}`);

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

function parsePackOutput(output) {
	const start = Math.max(output.lastIndexOf('\n{'), output.startsWith('{') ? 0 : -1);
	if (start === -1) throw new Error('pnpm pack did not return package metadata.');
	return JSON.parse(output.slice(start === 0 ? 0 : start + 1));
}

function rewriteLocalVersions(manifest, version) {
	const rewritten = { ...manifest, version };
	for (const field of [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'optionalDependencies',
	]) {
		if (!rewritten[field]) continue;
		rewritten[field] = { ...rewritten[field] };
		for (const dependency of packageNames) {
			if (dependency in rewritten[field]) rewritten[field][dependency] = version;
		}
	}
	return rewritten;
}

function collectPackageManifests(directory, visited = new Set()) {
	const realDirectory = realpathSync(directory);
	if (visited.has(realDirectory)) return [];
	visited.add(realDirectory);
	const manifests = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (!statSync(path).isDirectory()) continue;
		if (entry === 'node_modules') {
			for (const scopeEntry of readdirSync(path)) {
				const scopePath = join(path, scopeEntry);
				if (!statSync(scopePath).isDirectory()) continue;
				manifests.push(...collectPackageManifests(scopePath, visited));
			}
			continue;
		}
		const manifestPath = join(path, 'package.json');
		try {
			manifests.push({ path: manifestPath, value: JSON.parse(readFileSync(manifestPath, 'utf8')) });
		} catch {}
		manifests.push(...collectPackageManifests(path, visited));
	}
	return manifests;
}

function verifyFreshConsumer(artifacts, version) {
	const consumer = mkdtempSync(join(tmpdir(), 'flue-samva-consumer-'));
	try {
		writeFileSync(
			join(consumer, 'package.json'),
			JSON.stringify(
				{
					name: 'flue-samva-artifact-check',
					private: true,
					type: 'module',
					dependencies: Object.fromEntries([
						...artifacts.map((artifact) => [artifact.name, `file:${artifact.path}`]),
						['react', '^19.1.1'],
						['vite', '^8.1.2'],
					]),
				},
				null,
				2,
			),
		);
		run('bun', ['install'], { cwd: consumer });
		writeFileSync(
			join(consumer, 'verify.mjs'),
			`import { defineTool } from '@flue/runtime';\n` +
				`import { createFlueClient } from '@flue/sdk';\n` +
				`import { useFlueAgent } from '@flue/react';\n` +
				`import { flue } from '@flue/vite';\n` +
				`for (const [name, value] of Object.entries({ defineTool, createFlueClient, useFlueAgent, flue })) {\n` +
				`  if (typeof value !== 'function') throw new Error(name + ' export is unavailable');\n` +
				`}\n`,
		);
		run('bun', ['verify.mjs'], { cwd: consumer });
		const installed = collectPackageManifests(join(consumer, 'node_modules')).filter(({ value }) =>
			packageNames.includes(value.name),
		);
		for (const name of packageNames) {
			const matches = installed.filter(({ value }) => value.name === name);
			if (matches.length !== 1 || matches[0].value.version !== version) {
				throw new Error(
					`Fresh consumer resolved ${name} ${matches.length} time(s): ${matches.map(({ value }) => value.version).join(', ')}`,
				);
			}
		}
	} finally {
		rmSync(consumer, { recursive: true, force: true });
	}
}

function main() {
	const dirty = run('git', ['status', '--porcelain'], { capture: true }).trim();
	if (dirty) throw new Error('Integration packaging requires a clean committed worktree.');
	const sourceCommit = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
	const sourceTree = run('git', ['rev-parse', 'HEAD^{tree}'], { capture: true }).trim();
	const originalVersion = JSON.parse(
		readFileSync(join(repositoryRoot, 'packages/runtime/package.json'), 'utf8'),
	).version;
	const version = `${originalVersion}-samva.${sourceCommit.slice(0, 12)}.${sourceTree.slice(0, 12)}`;

	run('pnpm', [
		'--filter',
		'@flue/runtime',
		'--filter',
		'@flue/sdk',
		'--filter',
		'@flue/react',
		'--filter',
		'@flue/vite',
		'run',
		'build',
	]);

	mkdirSync(outputDirectory, { recursive: true });
	const stagingRoot = mkdtempSync(join(tmpdir(), 'flue-samva-pack-'));
	const artifacts = [];
	try {
		for (const packageDirectory of packageDirectories) {
			const sourceDirectory = join(repositoryRoot, 'packages', packageDirectory);
			const originalDirectory = join(stagingRoot, 'original', packageDirectory);
			mkdirSync(originalDirectory, { recursive: true });
			const packed = parsePackOutput(
				run('pnpm', ['pack', '--json', '--pack-destination', originalDirectory], {
					cwd: sourceDirectory,
					capture: true,
				}),
			);
			const stagedDirectory = join(stagingRoot, 'staged', packageDirectory);
			mkdirSync(stagedDirectory, { recursive: true });
			run('tar', ['-xzf', packed.filename, '-C', stagedDirectory, '--strip-components=1']);
			const manifestPath = join(stagedDirectory, 'package.json');
			const manifest = rewriteLocalVersions(
				JSON.parse(readFileSync(manifestPath, 'utf8')),
				version,
			);
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
			const finalDirectory = join(stagingRoot, 'final', packageDirectory);
			mkdirSync(finalDirectory, { recursive: true });
			const finalPack = parsePackOutput(
				run('pnpm', ['pack', '--json', '--ignore-scripts', '--pack-destination', finalDirectory], {
					cwd: stagedDirectory,
					capture: true,
				}),
			);
			const artifactPath = join(outputDirectory, basename(finalPack.filename));
			cpSync(finalPack.filename, artifactPath);
			artifacts.push({
				name: manifest.name,
				version,
				path: artifactPath,
				sha256: sha256(artifactPath),
			});
		}
		if (run('git', ['status', '--porcelain'], { capture: true }).trim()) {
			throw new Error('Build or prepack changed tracked source; refusing non-reproducible artifacts.');
		}
		verifyFreshConsumer(artifacts, version);
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}

	const manifestPath = join(
		outputDirectory,
		`flue-samva-${sourceCommit.slice(0, 12)}-manifest.json`,
	);
	const manifest = {
		schemaVersion: 1,
		sourceCommit,
		sourceTree,
		version,
		packageManager: 'pnpm@11.1.1',
		consumerRuntime: 'bun',
		artifacts,
	};
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Source ${sourceCommit}`);
	console.log(`Tree ${sourceTree}`);
	console.log(`Version ${version}`);
	for (const artifact of artifacts) {
		console.log(`Artifact ${artifact.name} ${artifact.path}`);
		console.log(`SHA256 ${artifact.sha256}`);
	}
	console.log(`Manifest ${manifestPath}`);
}

main();
