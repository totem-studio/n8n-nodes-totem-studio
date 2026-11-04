/** Real tooling lives outside the public build graph; the same packed bytes are tested and published. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { probePublicConsumer } from './probe-public-consumer.mjs';

const command = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFields = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

// Explicit test-host policy, not an installable nested package in the source
// snapshot. These inspected tools retain the canonical host's security patches.
export const PUBLIC_QA_HOST_MANIFEST = {
	name: 'totem-public-package-qa-host', version: '1.0.0', private: true,
	devDependencies: { '@n8n/node-cli': '0.54.5', eslint: '9.29.0', 'n8n-core': '2.43.3', 'n8n-workflow': '2.43.3' },
	overrides: { 'axios@1.18.0': '1.20.0', 'fast-xml-parser@4.4.1': '4.5.7', 'qs@6.15.2': '6.16.1' },
};

/** Write only a new, caller-selected external host. Installing its lock is an explicit separate step. */
export async function preparePublicQaHost(directory, options = {}) {
	const host = resolve(directory);
	if (host === resolve(ROOT) || resolve(ROOT).startsWith(host + sep) || host.startsWith(resolve(ROOT) + sep)) {
		throw new Error('QA tooling must be outside the public source tree');
	}
	const entries = await readdir(host).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
	if (entries.length) throw new Error('QA host output must be empty');
	const lock = JSON.parse(await readFile(options.bootstrapLock ?? join(ROOT, 'public/qa-host-package-lock.json'), 'utf8'));
	if (options.bootstrapLock) {
		lock.name = PUBLIC_QA_HOST_MANIFEST.name;
		lock.version = PUBLIC_QA_HOST_MANIFEST.version;
		lock.packages[''] = { name: lock.name, version: lock.version, devDependencies: PUBLIC_QA_HOST_MANIFEST.devDependencies };
	} else if (lock.name !== PUBLIC_QA_HOST_MANIFEST.name || lock.version !== PUBLIC_QA_HOST_MANIFEST.version
		|| !sameFields(lock.packages?.['']?.devDependencies, PUBLIC_QA_HOST_MANIFEST.devDependencies)) {
		throw new Error('QA tooling lock must match the declared exact test host');
	}
	await mkdir(host, { recursive: true });
	await writeFile(join(host, 'package.json'), JSON.stringify(PUBLIC_QA_HOST_MANIFEST, null, 2) + '\n');
	await writeFile(join(host, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
	return { directory: host, bootstrapOnly: Boolean(options.bootstrapLock), manifest: PUBLIC_QA_HOST_MANIFEST };
}

async function assertQaHost(directory) {
	if (!directory) throw new Error('Pass the separately installed, patched QA host directory');
	const host = resolve(directory);
	const manifest = JSON.parse(await readFile(join(host, 'package.json'), 'utf8'));
	assert.equal(manifest.name, PUBLIC_QA_HOST_MANIFEST.name);
	assert.equal(manifest.private, true);
	assert.deepEqual(manifest.devDependencies, PUBLIC_QA_HOST_MANIFEST.devDependencies);
	assert.deepEqual(manifest.overrides, PUBLIC_QA_HOST_MANIFEST.overrides);
	for (const [name, version] of Object.entries(PUBLIC_QA_HOST_MANIFEST.devDependencies)) {
		const installed = JSON.parse(await readFile(join(host, 'node_modules', name, 'package.json'), 'utf8'));
		assert.equal(installed.version, version, `QA host ${name} does not match its declared version`);
	}
	for (const [name, version] of [['axios', '1.20.0'], ['qs', '6.16.1'], ['fast-xml-parser', '4.5.7']]) {
		const installed = JSON.parse(await readFile(join(host, 'node_modules', name, 'package.json'), 'utf8'));
		assert.equal(installed.version, version, `QA host must retain its ${name} security patch`);
	}
	return host;
}

async function sourceRuleInputs(directory) {
	const files = ['package.json'];
	async function walk(folder) {
		for (const item of await readdir(join(directory, folder), { withFileTypes: true })) {
			const path = `${folder}/${item.name}`;
			if (item.isDirectory()) await walk(path);
			else if (item.isFile() && /\.(?:js|ts|json)$/.test(path)) files.push(path);
		}
	}
	await walk('nodes');
	await walk('credentials');
	return files.sort();
}

/** Run the unmodified default CLI config over a complete public source copy, never a filtered code subset. */
export async function lintPublicSource(directory, hostDirectory) {
	const source = resolve(directory), host = await assertQaHost(hostDirectory);
	const receipt = JSON.parse(await readFile(join(source, '.source-export.json'), 'utf8'));
	assert.equal(receipt.state, 'REVIEWABLE_SOURCE_SNAPSHOT_NOT_PUBLISHED', 'Bootstrap snapshots are not reviewable release sources');
	const declared = new Map(receipt.files.map(row => [row.path, row.sha256]));
	const ruleInputs = await sourceRuleInputs(source);
	for (const path of ruleInputs) assert.ok(declared.has(path), `Undeclared public lint input: ${path}`);
	const cli = join(host, 'node_modules/@n8n/node-cli');
	const expected = await readFile(join(cli, 'dist/template/templates/shared/default/eslint.config.mjs'));
	assert.deepEqual(await readFile(join(source, 'eslint.config.mjs')), expected, 'Public lint must use the exact official default config');
	const copy = await mkdtemp(join(host, '.public-source-lint-'));
	try {
		for (const [path, sha256] of declared) {
			const target = resolve(copy, path);
			assert.ok(target.startsWith(copy + sep), 'Source receipt path leaves its copy');
			assert.equal(hash(await readFile(join(source, path))), sha256, `Changed public source: ${path}`);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(join(source, path), target);
		}
		assert.deepEqual(await sourceRuleInputs(copy), ruleInputs);
		const result = await command(process.execPath, [join(cli, 'bin/n8n-node.mjs'), 'lint'], {
			cwd: copy, maxBuffer: 8 * 1024 * 1024,
			env: { ...process.env, PATH: join(host, 'node_modules/.bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
				npm_config_offline: 'true', npm_config_yes: 'false', npm_config_update_notifier: 'false' },
		});
		return { sourceFiles: declared.size, ruleInputs, cliVersion: PUBLIC_QA_HOST_MANIFEST.devDependencies['@n8n/node-cli'],
			defaultConfigSha256: hash(expected), stdout: result.stdout, stderr: result.stderr };
	} finally {
		await rm(copy, { recursive: true, force: true });
	}
}

/** Install one already-packed artifact beneath the real host; never resolve or bundle another peer. */
export async function verifyPublicPackage(tarball, hostDirectory, options = {}) {
	if (!tarball) throw new Error('Pass the exact packed public tarball, followed by its QA host directory');
	const host = await assertQaHost(hostDirectory), file = resolve(tarball);
	const sha256 = hash(await readFile(file));
	const listing = await command('tar', ['-tzf', file], { maxBuffer: 2 * 1024 * 1024 });
	for (const path of listing.stdout.trim().split('\n')) {
		assert.ok(path.startsWith('package/') && !path.split('/').includes('..'), 'Packed path leaves its package');
	}
	const types = await command('tar', ['-tvzf', file], { maxBuffer: 2 * 1024 * 1024 });
	assert.ok(types.stdout.trim().split('\n').every(line => /^[d-]/.test(line)), 'Packed symlinks are not supported');
	const run = await mkdtemp(join(host, '.public-package-test-'));
	try {
		const modules = join(run, 'node_modules');
		await mkdir(modules);
		await command('tar', ['-xzf', file, '-C', modules]);
		const installed = join(modules, 'n8n-nodes-totem-studio');
		await rename(join(modules, 'package'), installed);
		const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
		assert.equal(manifest.name, 'n8n-nodes-totem-studio');
		assert.equal(manifest.dependencies, undefined);
		assert.equal(manifest.overrides, undefined);
		const artifact = resolve(options.artifactDirectory ?? join(ROOT, '.release/public'));
		for (const path of listing.stdout.trim().split('\n').filter(path => !path.endsWith('/'))) {
			const name = path.slice('package/'.length);
			assert.deepEqual(await readFile(join(installed, name)), await readFile(join(artifact, name)), `Packed bytes differ from the built artifact: ${name}`);
		}
		const result = await probePublicConsumer(installed, host);
		assert.equal(result.httpRequests, 2);
		assert.equal(hash(await readFile(file)), sha256, 'The tested tarball changed');
		return { ...result, file, sha256, installedArtifact: relative(host, installed), identicalHostPeer: true, packedBytesMatchBuild: true };
	} finally {
		await rm(run, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, first, second, fourth] = process.argv.slice(2);
	if (action === 'prepare') {
		if (!first) throw new Error('Pass an empty external QA host directory');
		console.log(JSON.stringify(await preparePublicQaHost(first, second === '--bootstrap-lock' ? { bootstrapLock: fourth } : {})));
	} else if (action === 'lint') console.log(JSON.stringify(await lintPublicSource(ROOT, first)));
	else if (action === 'verify') console.log(JSON.stringify(await verifyPublicPackage(first, second)));
	else throw new Error('Use prepare <external-host>, lint <installed-host>, or verify <tarball> <installed-host>');
}
