import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PUBLIC_PACKAGE_DIRECTORY } from './build-public-package.mjs';

const command = promisify(execFile);

/** Pack the generated API-only artifact; this function never publishes or logs in. */
export async function packPublicPackage(directory = PUBLIC_PACKAGE_DIRECTORY, destination = dirname(PUBLIC_PACKAGE_DIRECTORY)) {
	await mkdir(destination, { recursive: true });
	const { stdout } = await command('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', destination], {
		maxBuffer: 2 * 1024 * 1024,
		env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
	});
	const [packed] = JSON.parse(stdout);
	const file = join(destination, packed.filename);
	const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
	await writeFile(`${file}.sha256`, `${sha256}  ${packed.filename}\n`, { mode: 0o644 });
	return { file, sha256, integrity: packed.integrity, size: packed.size, unpackedSize: packed.unpackedSize, files: packed.files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(await packPublicPackage()));
}
