import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePublicPackage } from './smoke-public-package.mjs';

/** Load an installed artifact with its real host, then exercise only a local HTTP boundary. */
export async function probePublicConsumer(directory, hostDirectory) {
	const installed = resolve(directory);
	const host = resolve(hostDirectory);
	const hostRequire = createRequire(join(host, 'package.json'));
	const artifactRequire = createRequire(join(installed, 'package.json'));
	assert.equal(artifactRequire('n8n-workflow'), hostRequire('n8n-workflow'), 'the installed public artifact must use the exact host peer');
	const loaded = await smokePublicPackage(installed, host);
	const manifest = artifactRequire('./package.json');
	const { TotemStudio } = artifactRequire(join(installed, manifest.n8n.nodes[0]));
	const requests = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.headers.authorization, 'Bearer tsk_live_consumer_fixture');
			let text = '';
			for await (const chunk of request) {
				text += chunk;
				assert.ok(Buffer.byteLength(text) <= 1024, 'consumer probe request is bounded');
			}
			requests.push({ method: request.method, path: request.url });
			let body;
			if (request.method === 'GET' && request.url === '/v1/me') {
				assert.equal(request.headers['totem-team'], undefined);
				body = { object: 'integration', id: 'prn_Consumer', name: 'Consumer probe',
					teams: ['team_Consumer'], scopes: ['crm:read'] };
			} else {
				assert.equal(request.method, 'POST');
				assert.equal(request.url, '/v1/leads/search');
				assert.equal(request.headers['totem-team'], 'team_Consumer');
				assert.deepEqual(JSON.parse(text), { email: 'probe@example.invalid' });
				body = { object: 'list', data: [{ object: 'lead', id: 'lead_Consumer' }],
					has_more: false, next_cursor: null };
			}
			response.writeHead(200, { 'content-type': 'application/json', 'totem-request-id': 'req_consumer' });
			response.end(JSON.stringify(body));
		} catch {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end('{"code":"consumer_probe_boundary_failed"}');
		}
	});
	await new Promise((accept, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', accept);
	});
	try {
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		const parameters = { resource: 'lead', operation: 'findByEmail', teamId: 'team_Consumer',
			email: 'probe@example.invalid' };
		const context = {
			getNode: () => ({ name: 'Totem Studio', type: 'n8n-nodes-totem-studio.totemStudioPublic', typeVersion: 1 }),
			getInputData: () => [{ json: {} }],
			getCredentials: async name => {
				assert.equal(name, 'totemStudioPublicApi');
				return { accessToken: 'tsk_live_consumer_fixture' };
			},
			getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
			continueOnFail: () => false,
			helpers: { httpRequestWithAuthentication: async (name, options) => {
				assert.equal(name, 'totemStudioPublicApi');
				const url = new URL(options.url);
				assert.equal(url.origin, 'https://api.totemstudio.ai');
				assert.ok(['/v1/me', '/v1/leads/search'].includes(url.pathname));
				assert.equal(url.search, '');
				assert.equal(options.disableFollowRedirect, true);
				assert.equal(options.sendCredentialsOnCrossOriginRedirect, false);
				const received = await fetch(`http://127.0.0.1:${address.port}${url.pathname}`, {
					method: options.method, redirect: 'error', signal: AbortSignal.timeout(5000),
					headers: { ...options.headers, Authorization: 'Bearer tsk_live_consumer_fixture', Connection: 'close' },
					...(options.body ? { body: JSON.stringify(options.body) } : {}),
				});
				return { statusCode: received.status, headers: Object.fromEntries(received.headers), body: await received.json() };
			} },
		};
		const result = await new TotemStudio().execute.call(context);
		assert.equal(result[0][0].json.lead.id, 'lead_Consumer');
		assert.equal(result[0][0].json.requestId, 'req_consumer');
		assert.deepEqual(requests, [{ method: 'GET', path: '/v1/me' }, { method: 'POST', path: '/v1/leads/search' }]);
		return { ...loaded, nodeVersion: process.version, consumerNodeRange: manifest.engines.node,
			coreVersion: hostRequire('n8n-core/package.json').version,
			workflowVersion: hostRequire('n8n-workflow/package.json').version, httpRequests: requests.length };
	} finally {
		server.closeAllConnections();
		await new Promise(accept => server.close(accept));
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2] || !process.argv[3]) throw new Error('Pass installed public package and host directories.');
	console.log(JSON.stringify(await probePublicConsumer(process.argv[2], process.argv[3])));
}
