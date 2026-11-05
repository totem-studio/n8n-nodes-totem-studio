import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { getHttpStatusCode } from './publicApiUtils';
import { resolveTotemStudioV2Operation } from './totemStudioV2Operations';
import type { PublicApiExecutionAuthority } from './publicApiExecutionContext';
import { validBusinessRequest, projectBusinessResponse, projectSourceMutation, projectOperationResponse, validSourceEtag, validBookingActionEtag } from './publicApiBusiness';

export const TOTEM_STUDIO_V2_CREDENTIAL = 'totemStudioTenantApi';
export const TOTEM_STUDIO_V2_GATEWAY_ORIGIN = 'https://api.totemstudio.ai';
export const TOTEM_STUDIO_V2_API_PREFIX = '/v1';
type Context = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maximumLength = 200): string | undefined {
	if (typeof value !== 'string') return undefined;
	const cleaned = value.trim();
	return cleaned &&
		cleaned.length <= maximumLength &&
		!Array.from(cleaned).some(
			(character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
		)
		? cleaned
		: undefined;
}

export function validPublicId(value: unknown, prefix: string, maximum = 128): value is string {
	return (
		typeof value === 'string' &&
		value.length <= maximum &&
		new RegExp('^' + prefix + '_[0-9A-Za-z]+$', 'u').test(value)
	);
}

export type TotemStudioV2ErrorCode =
	| 'capability_denied'
	| 'conflict'
	| 'gateway_contract_error'
	| 'gateway_unavailable'
	| 'invalid_credentials'
	| 'invalid_request'
	| 'network_error'
	| 'not_found'
	| 'outcome_unknown'
	| 'idempotency_key_reused'
	| 'idempotency_in_progress'
	| 'precondition_failed'
	| 'rate_limited'
	| 'resync_required';
const ERROR_MESSAGES: Record<TotemStudioV2ErrorCode, string> = {
	capability_denied: 'This Totem Studio connection does not allow that operation.',
	conflict:
		'Totem Studio could not apply the request because the resource changed. Refresh it and try again.',
	gateway_contract_error:
		'Totem Studio returned an invalid API response. Contact Totem Studio support with the execution time.',
	gateway_unavailable: 'Totem Studio is temporarily unavailable. Try again later.',
	invalid_credentials: 'The Totem Studio API key is invalid, expired, revoked, or suspended.',
	invalid_request: 'Totem Studio rejected the request. Check the required fields and formats.',
	network_error: 'The Totem Studio API could not be reached. Try again later.',
	not_found:
		'The requested Totem Studio resource was not found or is not available to this connection.',
	outcome_unknown: 'The write outcome is unknown. Do not submit a new key. Reconcile the resource or contact support using the idempotency key.',
	idempotency_key_reused: 'This idempotency key was already used for a different request. Reconcile the original request before starting a new write.',
	idempotency_in_progress: 'This write is still processing. Reconcile or retry the same request with the same idempotency key later.',
	precondition_failed: 'The resource version changed. Read its current version and review the change before submitting it again.',
	rate_limited: 'This Totem Studio connection has reached its request limit. Try again later.',
	resync_required: 'The saved cursor is no longer usable. Restart synchronization for this team.',
};

export class TotemStudioV2ClientError extends Error {
	constructor(
		public readonly code: TotemStudioV2ErrorCode,
		public readonly statusCode?: number,
		public readonly retryable = false,
		public readonly requestId?: string,
		public readonly retryAfter?: number,
		public readonly idempotencyKey?: string,
	) {
		super(ERROR_MESSAGES[code]);
		this.name = 'TotemStudioV2ClientError';
	}
}

/** Only our curated domain error, directly or at the native node's one cause boundary. */
export function totemStudioV2ErrorCause(error: unknown): TotemStudioV2ClientError | undefined {
	if (error instanceof TotemStudioV2ClientError) return error;
	if (error instanceof NodeOperationError && error.cause instanceof TotemStudioV2ClientError) return error.cause;
	return undefined;
}

function errorFromHttp(error: unknown): TotemStudioV2ClientError {
	const status = getHttpStatusCode(error);
	const response = isRecord(error) && isRecord(error.response) ? error.response : {};
	const body = isRecord(response.data)
		? response.data
		: isRecord(response.body)
			? response.body
			: {};
	const requestId = safeString(body.request_id, 128);
	const headers = isRecord(response.headers) ? response.headers : {};
	const retryAfter = Number(headers['retry-after']);
	const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
	const code: TotemStudioV2ErrorCode =
		body.code === 'outcome_unknown' || body.code === 'idempotency_key_reused' || body.code === 'idempotency_in_progress'
			? body.code
			: status === 412 || status === 428
				? 'precondition_failed'
				: status === 401
			? 'invalid_credentials'
			: status === 403
				? 'capability_denied'
				: status === 404
					? 'not_found'
					: status === 410 || body.code === 'resync_required'
						? 'resync_required'
						: status === 409
							? 'conflict'
							: status === 429
								? 'rate_limited'
								: status !== undefined && status >= 500
									? 'gateway_unavailable'
									: status !== undefined
										? 'invalid_request'
										: 'network_error';
	return new TotemStudioV2ClientError(
		code,
		status,
		code === 'rate_limited' || code === 'gateway_unavailable' || code === 'network_error',
		requestId,
		delay,
	);
}

interface ApiResponse {
	data: IDataObject;
	requestId?: string;
	etag?: string;
}

async function request(
	context: Context,
	input: {
		path: string;
		method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
		team?: string;
		body?: IDataObject;
		query?: IDataObject;
		idempotencyKey?: string;
		ifMatch?: string;
		deletedNote?: string;
		expectedStatus?: number;
		writeContext?: string;
		observationTimeoutMs?: number;
	},
	credentialType = TOTEM_STUDIO_V2_CREDENTIAL,
): Promise<ApiResponse> {
	const credentials = await context.getCredentials(credentialType);
	if (
		typeof credentials.accessToken !== 'string' ||
		credentials.accessToken.length > 256 ||
		!/^tsk_live_[0-9A-Za-z]+_[0-9A-Za-z]+$/u.test(credentials.accessToken)
	) {
		throw new TotemStudioV2ClientError('invalid_credentials', 401);
	}
	const options: IHttpRequestOptions = {
		method: input.method ?? 'GET',
		url: TOTEM_STUDIO_V2_GATEWAY_ORIGIN + TOTEM_STUDIO_V2_API_PREFIX + input.path,
		headers: {
			Accept: 'application/json',
			...(input.team ? { 'Totem-Team': input.team } : {}),
			...(input.body ? { 'Content-Type': 'application/json' } : {}),
			...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
			...(input.ifMatch ? { 'If-Match': input.ifMatch } : {}),
			...(input.writeContext ? { 'X-Totem-Write-Context': input.writeContext } : {}),
		},
		// n8n's vendor HTTP adapter drops empty objects; keep explicit JSON on the wire.
		...(input.body ? { body: Object.keys(input.body).length === 0 ? '{}' : input.body } : {}),
		...(input.query && Object.keys(input.query).length ? { qs: input.query } : {}),
		json: true,
		returnFullResponse: true,
		timeout: input.observationTimeoutMs ?? 20_000,
		disableFollowRedirect: true,
		sendCredentialsOnCrossOriginRedirect: false,
	};
	try {
		const response: unknown = await context.helpers.httpRequestWithAuthentication.call(
			context,
			credentialType,
			options,
		);
		if (!isRecord(response) || input.expectedStatus !== undefined && response.statusCode !== input.expectedStatus)
			throw new TotemStudioV2ClientError('gateway_contract_error');
		const headers = isRecord(response.headers) ? response.headers : {};
		const requestId = safeString(headers['totem-request-id'], 128);
		const etag = safeString(headers.etag, 300);
		if (input.deletedNote && response.statusCode === 204)
			return { data: { object: 'lead_note_deletion', id: input.deletedNote, deleted: true }, ...(requestId ? { requestId } : {}), ...(etag ? { etag } : {}) };
		if (!isRecord(response.body)) throw new TotemStudioV2ClientError('gateway_contract_error');
		return { data: response.body as IDataObject, ...(requestId ? { requestId } : {}), ...(etag ? { etag } : {}) };
	} catch (error) {
		const failure = error instanceof TotemStudioV2ClientError ? error : errorFromHttp(error);
		if (!input.idempotencyKey) throw new NodeOperationError(context.getNode(), failure);
		const unknown = ['network_error', 'gateway_unavailable', 'gateway_contract_error', 'outcome_unknown'].includes(failure.code);
		throw new NodeOperationError(context.getNode(), new TotemStudioV2ClientError(unknown ? 'outcome_unknown' : failure.code, failure.statusCode,
			unknown ? false : failure.retryable, failure.requestId, failure.retryAfter, input.idempotencyKey));
	}
}

function assertList(body: IDataObject): IDataObject[] {
	if (
		body.object !== 'list' ||
		!Array.isArray(body.data) ||
		!body.data.every(isRecord) ||
		typeof body.has_more !== 'boolean' ||
		!(body.next_cursor === null || typeof body.next_cursor === 'string')
	) {
		throw new TotemStudioV2ClientError('gateway_contract_error');
	}
	if (body.has_more && !safeString(body.next_cursor, 8192))
		throw new TotemStudioV2ClientError('gateway_contract_error');
	return body.data as IDataObject[];
}

export interface TotemStudioV2Identity {
	/** Absent means tenant; an empty team list never confers hosted authority. */
	principalKind?: 'automation_service';
	connection: IDataObject;
	teams: Array<{ id: string; label: string }>;
	capabilities: string[];
	requestId?: string;
}

export async function getTotemStudioV2Identity(
	context: Context,
	credentialType = TOTEM_STUDIO_V2_CREDENTIAL,
): Promise<TotemStudioV2Identity> {
	const me = await request(context, { path: '/me' }, credentialType);
	if (
		me.data.object !== 'integration' ||
		!validPublicId(me.data.id, 'prn') ||
		typeof me.data.name !== 'string' ||
		!Array.isArray(me.data.teams) ||
		!me.data.teams.every((id) => validPublicId(id, 'team')) ||
		new Set(me.data.teams).size !== me.data.teams.length ||
		!Array.isArray(me.data.scopes) ||
		!me.data.scopes.every((scope) => safeString(scope, 120))
		|| me.data.principal_kind !== undefined && me.data.principal_kind !== 'automation_service'
	) {
		throw new TotemStudioV2ClientError('gateway_contract_error');
	}
	const authorizedTeams = me.data.teams as string[];
	const identity: TotemStudioV2Identity = {
		...(me.data.principal_kind === 'automation_service' ? { principalKind: 'automation_service' as const } : {}),
		connection: { id: me.data.id, name: me.data.name },
		teams: authorizedTeams.map(id => ({ id, label: id })),
		capabilities: me.data.scopes as string[],
		...(me.requestId ? { requestId: me.requestId } : {}),
	};
	// A write-only or notes-only key must not acquire teams:read just to use its
	// granted operations. /me already supplies the authoritative permitted IDs.
	if (identity.principalKind === 'automation_service') {
		if (authorizedTeams.length) throw new TotemStudioV2ClientError('gateway_contract_error');
		return identity;
	}
	if (!identity.capabilities.includes('teams:read')) return identity;
	const listed = await request(context, { path: '/teams' }, credentialType);
	const teams = assertList(listed.data).map((team) => {
		if (
			!validPublicId(team.id, 'team') ||
			!(team.name === null || typeof team.name === 'string') ||
			!authorizedTeams.includes(team.id)
		)
			throw new TotemStudioV2ClientError('gateway_contract_error');
		return { id: team.id, label: typeof team.name === 'string' ? team.name : team.id };
	});
	if (listed.data.has_more || new Set(teams.map(({ id }) => id)).size !== teams.length)
		throw new TotemStudioV2ClientError('gateway_contract_error');
	return { ...identity, teams };
}

/** Fixed tenant lifecycle feed transport, shared with the public polling ingress. */
export async function readTotemStudioV2Events(context: IPollFunctions, input: {
	identity: TotemStudioV2Identity; team: string; cursor?: string; start?: 'now' | 'retained';
}) {
	if (input.identity.principalKind || !input.identity.capabilities.includes('events:read')
		|| !input.identity.teams.some(team => team.id === input.team)) throw new TotemStudioV2ClientError('capability_denied', 403);
	if (input.cursor && input.start || input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 512))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	return request(context, { path: '/events', team: input.team, expectedStatus: 200,
		query: { limit: 100, ...(input.cursor ? { cursor: input.cursor } : input.start ? { start: input.start } : {}) } }, 'totemStudioPublicApi');
}

export async function executeTotemStudioV2Operation(
	context: IExecuteFunctions,
	input: {
		resource: string;
		operation: string;
		identity: TotemStudioV2Identity;
		team?: string;
		id?: string;
		value?: string;
		query?: IDataObject;
		note?: string;
		body?: IDataObject;
		idempotencyKey?: string;
		ifMatch?: string;
		executionAuthority?: PublicApiExecutionAuthority;
		/** Only bounded operations.get observation can shorten the existing read timeout. */
		observationTimeoutMs?: number;
	},
	credentialType = TOTEM_STUDIO_V2_CREDENTIAL,
): Promise<ApiResponse> {
	const registration = resolveTotemStudioV2Operation(input.resource, input.operation);
	if (!registration || registration.kind === 'identity')
		throw new TotemStudioV2ClientError('invalid_request', 400);
	if (input.observationTimeoutMs !== undefined && (registration.resource !== 'operation' || registration.operation !== 'get'
		|| !Number.isInteger(input.observationTimeoutMs) || input.observationTimeoutMs < 1 || input.observationTimeoutMs > 20_000))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	const scopes = typeof registration.scope === 'string' ? [registration.scope] : registration.scope;
	if (!scopes.every((scope) => input.identity.capabilities.includes(scope)))
		throw new TotemStudioV2ClientError('capability_denied', 403);
	const hosted = input.identity.principalKind === 'automation_service';
	if (hosted && registration.tenantOnly) throw new TotemStudioV2ClientError('capability_denied', 403);
	if (hosted && (!input.executionAuthority || input.executionAuthority.principalId !== input.identity.connection.id
		|| input.team !== undefined && input.executionAuthority.apiTeamId !== input.team)) throw new TotemStudioV2ClientError('invalid_credentials', 401);
	if (!hosted && input.executionAuthority) throw new TotemStudioV2ClientError('invalid_request', 400);
	if (
		registration.team &&
		(!validPublicId(input.team, 'team') ||
			!hosted && !input.identity.teams.some(({ id }) => id === input.team))
	)
		throw new TotemStudioV2ClientError('capability_denied', 403);
	if (registration.idPrefix && !validPublicId(input.id, registration.idPrefix))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	if (registration.note && !validPublicId(input.note, 'note', 256))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	if ((registration.kind === 'mutation' || registration.idempotency) && (!input.idempotencyKey || !/^[\x21-\x7e]{1,255}$/u.test(input.idempotencyKey)))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	if (registration.conditional && !(registration.bookingAction ? validBookingActionEtag(input.ifMatch)
		: registration.customValues ? validCustomValuesEtag(input.ifMatch) : validResourceEtag(input.ifMatch, registration.note ? input.note : input.id)))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	if (registration.sourceCondition && input.ifMatch !== undefined && !validSourceEtag(input.ifMatch, input.body?.lead_id))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	const businessOperation = registration.endpoint ?? registration.apiOperation;
	if (businessOperation && !validBusinessRequest(businessOperation, input.body, hosted)) throw new TotemStudioV2ClientError('invalid_request', 400);
	if (businessOperation === 'notifications.create' && input.body?.handoff_reason === 'missed_team_appointment'
		&& !input.identity.capabilities.includes('notifications:incidents:write')) throw new TotemStudioV2ClientError('capability_denied', 403);
	if (businessOperation === 'messages.send' && isRecord(input.body?.content) && input.body.content.kind === 'library'
		&& !input.identity.capabilities.includes('library:read')) throw new TotemStudioV2ClientError('capability_denied', 403);
	if (registration.kind === 'knowledge' && (!input.body
		|| Object.keys(input.body).some(key => !['query', 'max_results'].includes(key))
		|| typeof input.body.query !== 'string' || !input.body.query.trim() || input.body.query.trim().length > 1_000
		|| input.body.max_results !== undefined && (!Number.isInteger(input.body.max_results) || Number(input.body.max_results) < 1 || Number(input.body.max_results) > 8)))
		throw new TotemStudioV2ClientError('invalid_request', 400);
	const response = await request(
		context,
		{
			path: registration.path.replace('{id}', input.id ?? '').replace('{note}', input.note ?? ''),
			...(registration.team ? { team: input.team } : {}),
			...(input.executionAuthority ? { writeContext: input.executionAuthority.token } : {}),
			...(input.observationTimeoutMs !== undefined ? { observationTimeoutMs: input.observationTimeoutMs } : {}),
			...(registration.kind === 'search'
				? ({
						method: 'POST',
						body: { [input.operation === 'findByPhone' ? 'phone' : 'email']: input.value },
					} as const)
				: {}),
			...(input.query ? { query: input.query } : {}),
			...(registration.kind === 'knowledge' ? { method: 'POST', body: input.body } as const : {}),
			...(registration.kind === 'business' ? { method: registration.method, expectedStatus: 200, ...(input.body ? { body: input.body } : {}) } : {}),
			...(registration.kind === 'operation' ? { method: registration.method, expectedStatus: registration.endpoint ? 202 : 200, ...(input.body ? { body: input.body } : {}) } : {}),
			...(registration.kind === 'mutation' || registration.idempotency ? {
				method: registration.method,
				...(input.body ? { body: input.body } : {}),
				idempotencyKey: input.idempotencyKey,
				...(input.ifMatch ? { ifMatch: input.ifMatch } : {}),
				...(input.operation === 'deleteNote' ? { deletedNote: input.note } : {}),
			} : {}),
		},
		credentialType,
	);
	if (registration.kind === 'operation') {
		const projected = projectOperationResponse(response.data);
		if (!projected
			|| registration.resource === 'operation' && response.data.id !== input.id
			|| registration.endpoint && response.data.endpoint !== registration.endpoint
			|| registration.resource === 'task' && input.operation === 'complete' && isRecord(response.data.result) && response.data.result.id !== input.id) {
			throw new TotemStudioV2ClientError(registration.idempotency ? 'outcome_unknown' : 'gateway_contract_error',
				undefined, false, response.requestId, undefined, input.idempotencyKey);
		}
		response.data = projected;
	} else if (registration.kind === 'business') {
		const projected = registration.apiOperation && projectBusinessResponse(registration.apiOperation, response.data, input.id);
		if (!projected || registration.apiOperation === 'leads.scheduleContact' && input.body?.lead_id !== undefined
			&& (!isRecord(projected.lead) || projected.lead.id !== input.body.lead_id)) throw new TotemStudioV2ClientError(registration.idempotency ? 'outcome_unknown' : 'gateway_contract_error', undefined, false, response.requestId, undefined, input.idempotencyKey);
		response.data = projected;
	} else if (registration.kind === 'knowledge') {
		response.data = knowledgePassages(response.data);
	} else if (registration.kind === 'mutation') {
		const data = response.data;
		const source = projectSourceMutation(data, input.id, input.note);
		if (source) return { ...response, data: source };
		const validation = input.operation === 'upsert' && input.body?.validate_only === true && data.object === 'lead_validation' && data.valid === true;
		const sourceRequested = input.body?.response_view === 'source' || validSourceEtag(input.ifMatch, registration.note ? input.note : input.id);
		if (sourceRequested && !validation)
			throw new TotemStudioV2ClientError('outcome_unknown', undefined, false, response.requestId, undefined, input.idempotencyKey);
		const deleted = input.operation === 'deleteNote' && data.object === 'lead_note_deletion' && data.id === input.note && data.deleted === true;
		const noteFields = ['id', 'object', 'livemode', 'lead', 'version', 'created_at', 'updated_at', 'external_id'];
		const note = ['addNote', 'updateNote'].includes(input.operation) && data.object === 'lead_note_receipt' && isRecord(data.note) &&
			validPublicId(data.note.id, 'note', 256) && data.note.object === 'lead_note' && data.note.lead === input.id &&
			(!input.note || data.note.id === input.note) && Object.keys(data.note).every(key => noteFields.includes(key)) &&
			typeof data.note.livemode === 'boolean' && Number.isSafeInteger(data.note.version) && Number(data.note.version) >= 1 &&
			Boolean(safeString(data.note.created_at, 60)) && Boolean(safeString(data.note.updated_at, 60)) &&
			(data.note.external_id === null || (typeof data.note.external_id === 'string' && data.note.external_id.length <= 200));
		const lead = ['upsert', 'update', 'archive'].includes(input.operation) && data.object === 'lead_mutation' &&
			typeof data.created === 'boolean' && isRecord(data.lead) && data.lead.object === 'lead' && validPublicId(data.lead.id, 'lead') &&
			(!input.id || data.lead.id === input.id) && (!input.team || data.lead.team === input.team);
		const customValues = registration.customValues && validCustomValuesResponse(data, input.id, true) && validCustomValuesEtag(response.etag);
		if (!validation && !deleted && !note && !lead && !customValues)
			throw new TotemStudioV2ClientError('outcome_unknown', undefined, false, response.requestId, undefined, input.idempotencyKey);
		if (note) response.data = { object: 'lead_note_receipt', note: data.note as IDataObject };
	} else if (registration.kind !== 'detail') {
		const rows = assertList(response.data);
		if (registration.resource === 'lead' && input.operation === 'notes' && input.query?.view === 'source'
			&& !rows.every(row => row.object === 'lead_note_source' && validPublicId(row.id, 'note', 256) && row.lead === input.id && validSourceEtag(row.etag, row.id)))
			throw new TotemStudioV2ClientError('gateway_contract_error', undefined, false, response.requestId);
		if (registration.kind === 'dictionary' && response.data.has_more)
			throw new TotemStudioV2ClientError('gateway_contract_error');
		if (registration.kind === 'feed' && !safeString(response.data.next_cursor, 8192))
			throw new TotemStudioV2ClientError('gateway_contract_error');
		if (registration.kind === 'search')
			return {
				...response,
				data: {
					...response.data,
					found: rows.length > 0,
					ambiguous: rows.length > 1,
					lead: rows.length === 1 ? rows[0]! : null,
				},
			};
	} else if (registration.customValues ? !validCustomValuesResponse(response.data, input.id, false) || !validCustomValuesEtag(response.etag)
		: response.data.id !== input.id || response.data.object !== registration.resource) {
		throw new TotemStudioV2ClientError('gateway_contract_error');
	}
	return response;
}

/** Tool output exposes only the documented passages, never provider/source metadata. */
function knowledgePassages(data: IDataObject): IDataObject {
	if (data.object !== 'knowledge_search' || typeof data.status !== 'string' || !['ready', 'indexing'].includes(data.status)
		|| !Array.isArray(data.passages) || data.passages.length > 8)
		throw new TotemStudioV2ClientError('gateway_contract_error');
	const passages = data.passages.map(value => {
		if (!isRecord(value) || typeof value.text !== 'string' || !value.text || value.text.length > 1_200
			|| typeof value.title !== 'string' || value.title.length > 512
			|| !(value.section === null || typeof value.section === 'string' && value.section.length <= 512)
			|| !(value.page === null || Number.isSafeInteger(value.page) && Number(value.page) > 0)
			|| typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1)
			throw new TotemStudioV2ClientError('gateway_contract_error');
		return { text: value.text, title: value.title, section: value.section, page: value.page, score: value.score } as IDataObject;
	});
	return { object: 'knowledge_search', status: data.status, passages };
}

/** Retained module alias for existing internal callers. */
export const executeTotemStudioV2Read = executeTotemStudioV2Operation;

/** Custom-value snapshots have their own opaque validator; a lead version cannot authorize them. */
export function validCustomValuesEtag(value: unknown): value is string {
	return typeof value === 'string' && /^"lcv_[a-f0-9]{64}"$/u.test(value);
}

function validCustomValuesResponse(data: IDataObject, id: unknown, receipt: boolean): boolean {
	if (data.lead !== id || !validPublicId(data.lead, 'lead')) return false;
	if (receipt) return data.object === 'lead_custom_values_receipt'
		&& Object.keys(data).length === 5 && ['object', 'lead', 'changed', 'set_count', 'removed_count'].every(key => Object.prototype.hasOwnProperty.call(data, key))
		&& typeof data.changed === 'boolean' && [data.set_count, data.removed_count].every(count => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 50);
	if (data.object !== 'lead_custom_values' || Object.keys(data).length !== 3 || !Array.isArray(data.values)) return false;
	const names = new Set<string>();
	return data.values.every(row => {
		if (!isRecord(row) || !['name', 'label', 'value'].every(key => Object.prototype.hasOwnProperty.call(row, key))
			|| Object.keys(row).some(key => !['name', 'label', 'value', 'source'].includes(key))
			|| typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100
			|| Array.from(row.name).some(character => {
				const code = character.charCodeAt(0);
				return code <= 31 || code >= 127 && code <= 159 || code === 8232 || code === 8233;
			})
			|| names.has(row.name) || typeof row.label !== 'string' || row.label.length > 200
			|| typeof row.value !== 'string' || row.value.length > 2_000
			|| row.source !== undefined && (typeof row.source !== 'string' || !['form', 'call_extraction', 'manual', 'csv'].includes(row.source))) return false;
		names.add(row.name);
		return true;
	});
}

/** Strong validators are bound to the resource being changed, never wildcards or lists. */
export function validResourceEtag(value: unknown, id: unknown): value is string {
	if (typeof value !== 'string' || typeof id !== 'string') return false;
	if (validSourceEtag(value, id)) return true;
	const match = /^"([A-Za-z0-9_]+):([1-9][0-9]*)"$/u.exec(value);
	return Boolean(match && match[1] === id && Number.isSafeInteger(Number(match[2])));
}

export function buildTotemStudioV2ErrorResult(error: unknown): IDataObject {
	const safeError = totemStudioV2ErrorCause(error) ?? new TotemStudioV2ClientError('gateway_unavailable', undefined, true);
	return {
		ok: false,
		success: false,
		error: safeError.message,
		message: safeError.message,
		errorCode: safeError.code,
		retryable: safeError.retryable,
		...(safeError.statusCode !== undefined ? { statusCode: safeError.statusCode } : {}),
		...(safeError.requestId ? { requestId: safeError.requestId } : {}),
		...(safeError.retryAfter !== undefined ? { retryAfter: safeError.retryAfter } : {}),
		...(safeError.idempotencyKey ? { idempotencyKey: safeError.idempotencyKey } : {}),
	};
}
