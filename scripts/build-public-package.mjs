import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PUBLIC_PACKAGE_DIRECTORY = join(ROOT, '.release/public');
export const PUBLIC_PACKAGE_REPOSITORY = 'https://github.com/totem-studio/n8n-nodes-totem-studio.git';
/** One entry registry drives the internal build, standalone source export and public npm identities. */
export const PUBLIC_PACKAGE_ENTRIES = [
	{ source: 'public/TotemStudio.entry.ts', output: 'dist/nodes/TotemStudio/TotemStudioPublic.node', kind: 'nodes', name: 'totemStudioPublic' },
	{ source: 'public/TotemStudioEventTrigger.entry.ts', output: 'dist/nodes/TotemStudio/TotemStudioEventTrigger.node', kind: 'nodes', name: 'totemStudioEventTrigger' },
	{ source: 'public/TotemStudioPublicApi.entry.ts', output: 'dist/credentials/TotemStudioPublicApi.credentials', kind: 'credentials', name: 'totemStudioPublicApi' },
];
export function publicNodeCodex(packageName, nodeName) {
	return { node: `${packageName}.${nodeName}`, nodeVersion: '1.0', codexVersion: '1.0', categories: ['Communication', 'Sales'],
		resources: { primaryDocumentation: [{ url: 'https://totemstudio.ai/developers' }] } };
}
export function createPublicPackageManifest(original) {
	return {
		name: original.name, version: original.version,
		description: 'Connect n8n workflows and AI tools to the Totem Studio public API',
		license: 'MIT', author: original.author, homepage: 'https://totemstudio.ai/developers',
		repository: { type: 'git', url: PUBLIC_PACKAGE_REPOSITORY }, bugs: { email: 'hello@totemstudio.ai' },
		keywords: ['n8n-community-node-package', 'totem-studio', 'crm'], engines: { node: '>=24.18.0' },
		files: ['dist', 'examples'], publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
		n8n: { n8nNodesApiVersion: 1, strict: true,
			nodes: PUBLIC_PACKAGE_ENTRIES.filter(entry => entry.kind === 'nodes').map(entry => `${entry.output}.js`),
			credentials: PUBLIC_PACKAGE_ENTRIES.filter(entry => entry.kind === 'credentials').map(entry => `${entry.output}.js`) },
		peerDependencies: { 'n8n-workflow': original.peerDependencies['n8n-workflow'] },
	};
}

/** Build the public distribution from shared sources, never the internal node registry. */
export async function buildPublicPackage(outputDirectory = PUBLIC_PACKAGE_DIRECTORY, options = {}) {
	const output = resolve(outputDirectory);
	if (output === resolve(ROOT) || resolve(ROOT).startsWith(output + sep)) {
		throw new Error('The public output must not replace the repository or one of its parents');
	}
	if (output === PUBLIC_PACKAGE_DIRECTORY) await rm(output, { recursive: true, force: true });
	else {
		const existing = await readdir(output).catch(error => {
			if (error.code === 'ENOENT') return [];
			throw error;
		});
		if (existing.length) throw new Error('A custom public output directory must be empty');
	}
	await mkdir(output, { recursive: true, mode: 0o755 });
	const original = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
	const manifest = createPublicPackageManifest(original);
	const entryPoints = Object.fromEntries(PUBLIC_PACKAGE_ENTRIES.map(entry => [entry.output, join(ROOT,
		options.standalone ? `${entry.output.replace(/^dist\//, '')}.ts` : entry.source)]));
	const result = await build({
		entryPoints,
		absWorkingDir: ROOT,
		outdir: output,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node24',
		external: ['n8n-workflow'],
		metafile: true,
		legalComments: 'eof',
		sourcemap: false,
		logLevel: 'silent',
	});
	const imports = [...new Set(Object.values(result.metafile.outputs).flatMap(value => value.imports.map(item => item.path)))];
	if (imports.some(name => name !== 'n8n-workflow' && name !== 'node:crypto')) {
		throw new Error('The public package must use only n8n-workflow and the audited node:crypto built-in');
	}
	for (const folder of ['dist/nodes/TotemStudio', 'dist/credentials']) {
		await mkdir(join(output, folder), { recursive: true, mode: 0o755 });
		for (const icon of ['totemStudio.svg', 'totemStudio.dark.svg']) {
			await copyFile(join(ROOT, 'nodes/TotemStudio', icon), join(output, folder, icon));
		}
	}
	for (const entry of PUBLIC_PACKAGE_ENTRIES.filter(entry => entry.kind === 'nodes')) {
		await writeFile(join(output, `${entry.output}.json`), JSON.stringify(publicNodeCodex(manifest.name, entry.name), null, 2) + '\n', { mode: 0o644 });
	}
	await writeFile(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
	await copyFile(join(ROOT, 'README.md'), join(output, 'README.md'));
	await copyFile(join(ROOT, 'LICENSE'), join(output, 'LICENSE'));
	await mkdir(join(output, 'examples'), { mode: 0o755 });
	for (const example of await readdir(join(ROOT, 'examples'))) {
		if (example.endsWith('.json')) await copyFile(join(ROOT, 'examples', example), join(output, 'examples', example));
	}
	const summary = { directory: output, name: manifest.name, version: manifest.version,
		nodes: manifest.n8n.nodes, credentials: manifest.n8n.credentials, imports,
		sharedInputs: Object.keys(result.metafile.inputs).map(input => resolve(input)).sort() };
	await writeFile(join(output, '.build-receipt.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o644 });
	return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(await buildPublicPackage()));
}
