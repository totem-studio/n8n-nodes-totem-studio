import { createHash, randomUUID } from 'node:crypto';
import type { IDataObject, IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { TotemStudioV2ClientError } from './totemStudioV2Client';
import type { PublicApiExecutionAuthority } from './publicApiExecutionContext';

interface WriteAttempt {
	fingerprint: string;
	key: string;
	unknown?: boolean;
}
type WriteCache = Record<string, WriteAttempt>;
const fallbackContexts = new WeakMap<IExecuteFunctions, WriteCache>();

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function validateExplicitKey(explicitKey: unknown): asserts explicitKey is string {
	if (typeof explicitKey !== 'string' || (explicitKey !== '' && !/^[\x21-\x7e]{1,255}$/u.test(explicitKey)))
		throw new TotemStudioV2ClientError('invalid_request', 400);
}
function writeCache(context: IExecuteFunctions): WriteCache {
	if (typeof context.getContext === 'function') {
		const nodeContext = context.getContext('node');
		nodeContext.totemPublicApiWrites ??= {};
		return nodeContext.totemPublicApiWrites as unknown as WriteCache;
	}
	const cache = fallbackContexts.get(context) ?? {};
	fallbackContexts.set(context, cache);
	return cache;
}
function tenantSlot(context: IExecuteFunctions, index: number, operation: unknown): string {
	const run = typeof context.getWorkflowDataProxy === 'function' ? context.getWorkflowDataProxy(index).$thisRunIndex
		: (typeof context.getExecuteData === 'function' ? context.getExecuteData().runIndex : 0) ?? 0;
	return `${run}:${index}:${String(operation)}`;
}
const fingerprintOf = (request: IDataObject) => createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
function checkPrevious(previous: WriteAttempt | undefined, fingerprint: string, explicitKey: string): void {
	if (!previous) return;
	if (previous.fingerprint !== fingerprint || explicitKey && explicitKey !== previous.key)
		throw new TotemStudioV2ClientError('idempotency_key_reused', 409, false, undefined, undefined, previous.key);
	if (previous.unknown) throw new TotemStudioV2ClientError('outcome_unknown', 409, false, undefined, undefined, previous.key);
}
/** Existing tenant retry refusals and invalid header values stay ahead of identity HTTP. This never mints an unverified hosted intent. */
export function preflightPublicApiWrite(context: IExecuteFunctions, index: number, request: IDataObject, explicitKey: unknown): void {
	validateExplicitKey(explicitKey);
	const previous = writeCache(context)[tenantSlot(context, index, request.operation)];
	checkPrevious(previous, fingerprintOf(request), explicitKey);
}

/** n8n preserves node context during a retry; no customer body is retained here. */
export function preparePublicApiWrite(
	context: IExecuteFunctions,
	index: number,
	request: IDataObject,
	explicitKey: unknown,
	executionAuthority?: PublicApiExecutionAuthority,
): WriteAttempt {
	validateExplicitKey(explicitKey);
	const cache = writeCache(context);
	// Normal n8n stack entries omit executeData.runIndex. The data proxy carries
	// the engine's actual run index, including repeated Loop Over Items runs.
	let stable: string | undefined;
	if (executionAuthority) {
		const nodeId = context.getNode().id;
		if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 256)
			throw new TotemStudioV2ClientError('invalid_request', 400);
		stable = 'hst_' + createHash('sha256').update(JSON.stringify([executionAuthority.principalId, executionAuthority.rawTeamId,
			executionAuthority.executionId, nodeId, String(request.resource), String(request.operation), index])).digest('hex');
	}
	const slot = stable ?? tenantSlot(context, index, request.operation);
	const fingerprint = fingerprintOf(request);
	const previous = cache[slot];
	checkPrevious(previous, fingerprint, explicitKey);
	if (previous) return previous;
	const attempt = { fingerprint, key: explicitKey || stable || randomUUID() };
	cache[slot] = attempt;
	return attempt;
}

export function publicApiFields(value: unknown, node: INode): IDataObject {
	let fields: unknown;
	try { fields = typeof value === 'string' ? JSON.parse(value) : value; }
	catch { throw new NodeOperationError(node, new TotemStudioV2ClientError('invalid_request', 400)); }
	if (fields === null || typeof fields !== 'object' || Array.isArray(fields))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	// Routing, team and version authority have dedicated parameters. The API
	// validates the operation's strict field schema, consent and CRM guards.
	return fields as IDataObject;
}
