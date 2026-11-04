/** Opaque tenant event polling. Stage state only after every fetched page validates; never manufacture callback success. */
import { createHash } from 'node:crypto';
import type { IDataObject, INodeExecutionData, IPollFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { buildTotemStudioV2ErrorResult, getTotemStudioV2Identity, readTotemStudioV2Events, TotemStudioV2ClientError, validPublicId } from './totemStudioV2Client';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && Array.from(value).every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) < 127);
const names = ['operation.completed', 'call.completed', 'call.analysis_completed', 'booking.created', 'booking.rescheduled', 'booking.cancelled', 'assistant_run.completed'];
const statuses = ['succeeded', 'failed', 'cancelled', 'outcome_unknown', 'completed', 'ready', 'unavailable', 'created', 'rescheduled'];
interface EventPage { data: IDataObject[]; hasMore: boolean; cursor: string }
function page(value: IDataObject): EventPage {
	if (value.object !== 'event_list' || !Array.isArray(value.data) || value.data.length > 100 || typeof value.has_more !== 'boolean' || !token(value.next_cursor))
		throw new TotemStudioV2ClientError('gateway_contract_error');
	const data = value.data.map(row => {
		if (!record(row) || row.object !== 'event' || typeof row.id !== 'string' || !/^evt_(?:[a-f0-9]{48}|[a-f0-9]{64})$/u.test(row.id)
			|| !names.includes(String(row.name)) || !statuses.includes(String(row.status))
			|| !['operation', 'call', 'booking'].includes(String(row.resource_type))
			|| !validPublicId(row.resource_id, row.resource_type === 'operation' ? 'op' : row.resource_type === 'call' ? 'call' : 'bkg', 256)
			|| typeof row.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(row.occurred_at) || !Number.isFinite(Date.parse(row.occurred_at)))
			throw new TotemStudioV2ClientError('gateway_contract_error');
		return { object: 'event', id: row.id, name: row.name, resource_type: row.resource_type, resource_id: row.resource_id, status: row.status, occurred_at: row.occurred_at } as IDataObject;
	});
	return { data, hasMore: value.has_more, cursor: value.next_cursor };
}
interface EventState { version: 1; binding: string; cursor: string; seen: string[] }
function readState(value: unknown): EventState | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || value.version !== 1 || typeof value.binding !== 'string' || !/^[a-f0-9]{64}$/u.test(value.binding)
		|| !token(value.cursor) || !Array.isArray(value.seen) || value.seen.length > 1_000 || !value.seen.every(id => typeof id === 'string' && /^evt_(?:[a-f0-9]{48}|[a-f0-9]{64})$/u.test(id)))
		throw new TotemStudioV2ClientError('gateway_contract_error');
	return value as unknown as EventState;
}
export async function pollTotemStudioEvents(context: IPollFunctions): Promise<INodeExecutionData[][] | null> {
	try {
		const began = Date.now();
		const identity = await getTotemStudioV2Identity(context, 'totemStudioPublicApi');
		const selected = context.getNodeParameter('teamId', '');
		const team = typeof selected === 'string' && selected ? selected : identity.teams.length === 1 ? identity.teams[0]!.id : '';
		if (!validPublicId(team, 'team') || identity.principalKind || !identity.capabilities.includes('events:read') || !identity.teams.some(row => row.id === team))
			throw new TotemStudioV2ClientError('capability_denied', 403);
		const start = context.getNodeParameter('initialEvents', 'now');
		if (start !== 'now' && start !== 'retained') throw new TotemStudioV2ClientError('invalid_request', 400);
		const advanced: unknown = context.getNodeParameter('advanced', {});
		const restartCounter = record(advanced) ? advanced.restartCounter ?? 0 : undefined;
		if (typeof restartCounter !== 'number' || !Number.isSafeInteger(restartCounter) || restartCounter < 0) throw new TotemStudioV2ClientError('invalid_request', 400);
		const manual = context.getMode() === 'manual';
		const state = context.getWorkflowStaticData('node');
		const binding = createHash('sha256').update(JSON.stringify([identity.connection.id, team, context.getNode().credentials?.totemStudioPublicApi?.id ?? null, restartCounter])).digest('hex');
		const previous = manual ? undefined : readState(state.publicApiEvents);
		const current = previous?.binding === binding ? previous : undefined;
		let cursor = current?.cursor;
		const seen = new Set(current?.seen ?? []), output: INodeExecutionData[] = [];
		const budget = typeof context.getPollBudgetMs === 'function' ? context.getPollBudgetMs() : 300_000;
		for (let count = 0; count < (manual ? 1 : 3); count++) {
			if (count > 0 && Date.now() - began + 20_000 >= budget) break;
			const response = page((await readTotemStudioV2Events(context, { identity, team, ...(cursor ? { cursor } : { start: manual ? 'retained' : start }) })).data);
			if (!cursor && !manual && start === 'now' && (response.data.length || response.hasMore)) throw new TotemStudioV2ClientError('gateway_contract_error');
			if (response.hasMore && response.cursor === cursor) throw new TotemStudioV2ClientError('gateway_contract_error');
			for (const event of response.data) {
				const id = String(event.id);
				if (!seen.has(id)) { seen.add(id); output.push({ json: event }); }
			}
			cursor = response.cursor;
			if (!response.hasMore) break;
		}
		if (!manual && cursor) state.publicApiEvents = { version: 1, binding, cursor, seen: [...seen].slice(-1_000) };
		return output.length ? [output] : null;
	} catch (error) {
		const failure = buildTotemStudioV2ErrorResult(error);
		throw new NodeOperationError(context.getNode(), String(failure.message), { description: String(failure.errorCode) });
	}
}
