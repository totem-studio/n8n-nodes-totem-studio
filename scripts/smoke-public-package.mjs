import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The installed-artifact probe runs on an n8n host without builder dependencies.
const PUBLIC_PACKAGE_DIRECTORY = fileURLToPath(new URL('../.release/public', import.meta.url));

const require = createRequire(import.meta.url);
/** Use n8n's actual community-package loader, never CUSTOM aliases or a fake registry. */
export async function smokePublicPackage(directory = PUBLIC_PACKAGE_DIRECTORY, hostDirectory) {
	const hostRequire = hostDirectory ? createRequire(join(resolve(hostDirectory), 'package.json')) : require;
	const { PackageDirectoryLoader } = hostRequire('n8n-core/dist/nodes-loader/package-directory-loader.js');
	const loader = new PackageDirectoryLoader(resolve(directory));
	await loader.loadAll();
	assert.equal(loader.packageName, 'n8n-nodes-totem-studio');
	assert.deepEqual(Object.keys(loader.nodeTypes), ['totemStudioPublic', 'totemStudioEventTrigger']);
	assert.deepEqual(Object.keys(loader.credentialTypes), ['totemStudioPublicApi']);
	const node = loader.nodeTypes.totemStudioPublic.type;
	const credential = loader.credentialTypes.totemStudioPublicApi.type;
	assert.equal(node.description.hidden, undefined);
	assert.equal(node.description.version, 1);
	const trigger = loader.nodeTypes.totemStudioEventTrigger.type;
	assert.equal(trigger.description.polling, true);
	assert.equal(trigger.description.usableAsTool, undefined);
	assert.equal(trigger.description.hidden, undefined);
	assert.equal(typeof trigger.poll, 'function');
	assert.deepEqual(trigger.description.credentials, node.description.credentials);
	assert.deepEqual(credential.properties.map(property => property.name), ['apiAccessNotice', 'accessToken']);
	assert.deepEqual(credential.supportedNodes, ['totemStudioPublic', 'totemStudioEventTrigger']);
	assert.equal(credential.test.request.baseURL, 'https://api.totemstudio.ai');
	return { packageName: loader.packageName, nodeTypes: Object.keys(loader.nodeTypes), credentialTypes: Object.keys(loader.credentialTypes), packageVersion: loader.packageJson.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(JSON.stringify(await smokePublicPackage(process.argv[2], process.argv[3])));
}
