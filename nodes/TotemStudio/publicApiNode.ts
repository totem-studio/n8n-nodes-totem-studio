import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { cleanString, shouldContinueOnError, composeContactAtMs } from './publicApiUtils';
import {
	buildTotemStudioV2ErrorResult,
	executeTotemStudioV2Operation,
	getTotemStudioV2Identity,
	TOTEM_STUDIO_V2_CREDENTIAL,
	TotemStudioV2ClientError,
	totemStudioV2ErrorCause,
	validResourceEtag,
	validCustomValuesEtag,
	validPublicId,
	type TotemStudioV2Identity,
} from './totemStudioV2Client';
import {
	resolveTotemStudioV2Operation,
	TOTEM_STUDIO_V2_OPERATIONS,
} from './totemStudioV2Operations';
import { preparePublicApiWrite, preflightPublicApiWrite, publicApiFields } from './publicApiWriteContext';
import { INHERIT_TOTEM_EXECUTION_CONTEXT } from './runtimeExecutionContext';
import { resolvePublicApiExecutionContext } from './publicApiExecutionContext';
import { waitForPublicApiOperation, type PublicApiOperationObservation } from './publicApiOperationWait';
import { validBookingActionEtag, validSourceEtag } from './publicApiBusiness';
import { resolvePreparedVisitorResponse, formatPreparedVisitorResponse, PreparedVisitorResponseError, type PublicVisitorResponse } from './publicPreparedResponse';

type Show = Record<string, Array<string | number | boolean>>;
interface PublicApiNodeOptions {
	prefix?: string;
	show?: Show;
	credentialType?: string;
	resource?: string;
}

const RESOURCES = [
	{ name: 'Assistant', value: 'assistant' },
	{ name: 'Attachment', value: 'attachment' },
	{ name: 'Board', value: 'board' },
	{ name: 'Booking', value: 'booking' },
	{ name: 'Booking Payment', value: 'bookingPayment' },
	{ name: 'Booking Service', value: 'bookingService' },
	{ name: 'Call', value: 'call' },
	{ name: 'Catalog', value: 'catalog' },
	{ name: 'Connection', value: 'connection' },
	{ name: 'Conversation', value: 'conversation' },
	{ name: 'CRM', value: 'crm' },
	{ name: 'Knowledge', value: 'knowledge' },
	{ name: 'Lead', value: 'lead' },
	{ name: 'Library', value: 'library' },
	{ name: 'Member', value: 'member' },
	{ name: 'Message', value: 'message' },
	{ name: 'Notification', value: 'notification' },
	{ name: 'Operation', value: 'operation' },
	{ name: 'Quote', value: 'quote' },
	{ name: 'Referral', value: 'referral' },
	{ name: 'Sync', value: 'sync' },
	{ name: 'Task', value: 'task' },
	{ name: 'Team', value: 'team' },
];

function parameterName(name: string, prefix = ''): string {
	return prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function createTotemPublicApiProperties(
	options: PublicApiNodeOptions = {},
): INodeProperties[] {
	const name = (value: string) => parameterName(value, options.prefix);
	const visible = (show: Show = {}) => ({
		show: {
			...options.show,
			...Object.fromEntries(Object.entries(show).map(([key, values]) => [name(key), values])),
		},
	});
	const paged = ['list', 'activities', 'notes', 'changes'];
	const writes = TOTEM_STUDIO_V2_OPERATIONS.filter(item => item.kind === 'mutation').map(item => item.operation);
	return [
		...(!options.prefix ? [
			{ displayName: 'Tool Description', name: 'descriptionType', type: 'options', noDataExpression: true, default: 'manual',
				options: [{ name: 'Set Automatically', value: 'auto' }, { name: 'Set Manually', value: 'manual' }] },
			{ displayName: 'Description', name: 'toolDescription', type: 'string', default: '', displayOptions: { show: { descriptionType: ['manual'] } } },
		] satisfies INodeProperties[] : []),
		{ displayName: 'Automation Write Context', name: name('automationWriteContext'), type: 'hidden', default: INHERIT_TOTEM_EXECUTION_CONTEXT },
		{
			displayName:
				'Uses a key from Settings → Developers. CRM writes require crm:write; notes and custom values require their separate explicit content grants. Custom values have independent read/write scopes and ETags. Task and notification actions require tasks:write and notifications:write respectively, and return an operation whose status can be read separately. Reads return one API page.',
			name: name('publicApiNotice'),
			type: 'notice',
			default: '',
			displayOptions: visible(),
		},
		{
			displayName: 'Resource',
			name: name('resource'),
			type: 'options',
			noDataExpression: true,
			options: RESOURCES,
			default: 'connection',
			displayOptions: visible(),
		},
		...RESOURCES.map((resource): INodeProperties => {
			const field: INodeProperties = {
				displayName: 'Operation',
				name: name('operation'),
				type: 'options',
				noDataExpression: true,
				options: TOTEM_STUDIO_V2_OPERATIONS.filter(
					(registration) => registration.resource === resource.value,
				)
					.map((registration) => ({
						name: registration.name,
						value: registration.operation,
						action: registration.name + ' ' + resource.name.toLowerCase(),
					}))
					.sort((a, b) => a.name.localeCompare(b.name)),
				default: '',
				displayOptions: visible({ resource: [resource.value] }),
			};
			field.default =
				resource.value === 'connection'
					? 'whoAmI'
					: resource.value === 'sync'
						? 'changes'
						: resource.value === 'lead'
							? 'findByPhone'
							: ({ assistant: 'options', quote: 'recordOutcome', knowledge: 'search', task: 'create', operation: 'get', attachment: 'resolve', bookingPayment: 'get', catalog: 'search', crm: 'context', referral: 'create', message: 'send' } as Record<string, string>)[resource.value] ?? 'list';
			return field;
		}),
		...RESOURCES.flatMap(resource => {
			const operations = TOTEM_STUDIO_V2_OPERATIONS.filter(item => item.resource === resource.value && item.team).map(item => item.operation);
			return operations.length ? [{
			displayName: 'Workspace Name or ID', name: name('teamId'), type: 'options',
			typeOptions: { loadOptionsMethod: 'getFamilyWorkspaces' }, required: true, default: '',
			description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			displayOptions: visible({ resource: [resource.value], operation: operations }),
			} satisfies INodeProperties] : [];
		}),
		{
			displayName: 'Query', name: name('knowledgeQuery'), type: 'string', required: true, default: '',
			typeOptions: { rows: 3 },
			description: 'Question for the selected team\'s indexed knowledge, up to 1,000 characters. Requires a separate knowledge-content grant.',
			displayOptions: visible({ resource: ['knowledge'], operation: ['search'] }),
		},
		{
			displayName: 'Maximum Results', name: name('maxResults'), type: 'number', default: 4,
			typeOptions: { minValue: 1, maxValue: 8 },
			description: 'Maximum matching passages to return',
			displayOptions: visible({ resource: ['knowledge'], operation: ['search'] }),
		},
		...RESOURCES.flatMap(resource => {
			const operations = TOTEM_STUDIO_V2_OPERATIONS.filter(item => item.resource === resource.value && item.idPrefix).map(item => item.operation);
			return operations.length ? [{
			displayName: 'Record ID',
			name: name('recordId'),
			type: 'string',
			required: true,
			default: '',
			description: 'Public API ID of the record, such as lead_…, task_… or op_…',
			displayOptions: visible({ resource: [resource.value], operation: operations }),
			} satisfies INodeProperties] : [];
		}),
		{
			displayName: 'Note ID', name: name('noteId'), type: 'string', required: true, default: '',
			description: 'Opaque note_… ID belonging to the selected lead',
			displayOptions: visible({ resource: ['lead'], operation: ['updateNote', 'deleteNote'] }),
		},
		{
			displayName: 'Fields (JSON)', name: name('fields'), type: 'json', required: true, default: '{}',
			description: 'API request fields. Create or Resolve requires origin (import or inbound). Notes require body; archive requires reason. See the Totem API reference.',
			displayOptions: visible({ resource: ['lead'], operation: writes.filter(value => value !== 'deleteNote') }),
		},
		{
			displayName: 'Fields (JSON)', name: name('fields'), type: 'json', required: true,
			default: '{"title":"Follow up"}',
			description: 'Task fields from the API reference. A title is required. Lead and member references use public API IDs; times use UTC ISO strings.',
			displayOptions: visible({ resource: ['task'], operation: ['create'] }),
		},
		{
			displayName: 'Fields (JSON)', name: name('fields'), type: 'json', required: true,
			default: '{"note":"Please review this request"}',
			description: 'Business notification fields from the API reference. A note is required. Source identity and recipients are controlled by Totem.',
			displayOptions: visible({ resource: ['notification'], operation: ['create'] }),
		},
		{
			displayName: 'If-Match', name: name('ifMatch'), type: 'string', required: true, default: '',
			description: 'Current strong ETag including quotes. Source lead/note reads use lrs1_/lns1_; inventory reads use their record version. Custom values require lcv_. Read and review before making a new attempt after a conflict.',
			displayOptions: visible({ resource: ['lead'], operation: ['update', 'archive', 'updateNote', 'deleteNote', 'updateCustomValues'] }),
		},
		{
			displayName: 'If-Match', name: name('ifMatch'), type: 'string', required: true, default: '',
			description: 'The current quoted bka_ ETag from Inspect for Management. An inventory version cannot authorize this action.',
			displayOptions: visible({ resource: ['booking'], operation: ['cancel', 'reschedule'] }),
		},
		{ displayName: 'Source ETag (Optional)', name: name('ifMatch'), type: 'string', default: '',
			description: 'Current source lead ETag from CRM context. A stale review is refused; leave empty for a genuinely new contact.',
			displayOptions: visible({ resource: ['crm'], operation: ['scheduleContact'] }) },
		{ displayName: 'Schedule Time', name: name('scheduleTimeMode'), type: 'options', noDataExpression: true, default: 'iso',
			options: [{ name: 'ISO Timestamp in Fields', value: 'iso' }, { name: 'Local Date and Time', value: 'local' }],
			description: 'Local mode uses the same IANA timezone resolver as existing scheduled-contact workflows and rejects DST gaps or repeated times. Leave contact_at out of Fields in local mode.',
			displayOptions: visible({ resource: ['crm'], operation: ['scheduleContact'] }) },
		...['year', 'month', 'day', 'hour', 'minute'].map((part): INodeProperties => ({
			displayName: `Contact ${part.charAt(0).toUpperCase() + part.slice(1)}`, name: name(`contact${part.charAt(0).toUpperCase() + part.slice(1)}`), type: 'number', default: 0, required: true,
			displayOptions: visible({ resource: ['crm'], operation: ['scheduleContact'], scheduleTimeMode: ['local'] }),
		})),
		{ displayName: 'Contact Timezone', name: name('contactTimezone'), type: 'string', default: 'Europe/Madrid', required: true,
			description: 'IANA timezone for the promised local date, such as Europe/Madrid or Atlantic/Canary. Never an offset or a guessed UTC conversion.',
			displayOptions: visible({ resource: ['crm'], operation: ['scheduleContact'], scheduleTimeMode: ['local'] }) },
		...RESOURCES.filter(resource => !['lead', 'task', 'notification'].includes(resource.value)).flatMap(resource => {
			const operations = TOTEM_STUDIO_V2_OPERATIONS.filter(item => item.resource === resource.value && item.body === 'fields').map(item => item.operation);
			return operations.length ? [{ displayName: 'Fields (JSON)', name: name('fields'), type: 'json', required: true, default: '{}',
				description: 'Fields of this fixed public API operation. Use current opaque IDs/references; credentials, routing, recipients and actor authority cannot be overridden here.',
				displayOptions: visible({ resource: [resource.value], operation: operations }) } satisfies INodeProperties] : [];
		}),
		...RESOURCES.filter(resource => !['lead', 'task', 'notification'].includes(resource.value)).flatMap(resource => {
			const operations = TOTEM_STUDIO_V2_OPERATIONS.filter(item => item.resource === resource.value && item.idempotency).map(item => item.operation);
			return operations.length ? [{ displayName: 'Idempotency Key', name: name('idempotencyKey'), type: 'string', default: '',
				description: 'Keep one key for the same logical action. Hosted defaults derive from the original verified dispatch/action, including across n8n retries; uncertain effects are never repeated with a fresh key.',
				displayOptions: visible({ resource: [resource.value], operation: operations }) } satisfies INodeProperties] : [];
		}),
		...RESOURCES.flatMap(resource => {
			const operations = TOTEM_STUDIO_V2_OPERATIONS.filter(item => item.resource === resource.value && item.kind === 'operation' && item.endpoint).map(item => item.operation);
			return operations.length ? [
				{ displayName: 'Wait for Completion', name: name('waitForCompletion'), type: 'boolean', default: false,
					description: 'Whether to observe the same accepted operation with read requests only. The deadline returns its latest known status; queued or running is not a completed business action.',
					displayOptions: visible({ resource: [resource.value], operation: operations }) },
				{ displayName: 'Maximum Wait (Seconds)', name: name('maxWaitSeconds'), type: 'number', default: 20,
					typeOptions: { minValue: 1, maxValue: 60 },
					description: 'Bounded observation time. Reaching it never resubmits the action or manufactures success. Use Operation: Get with the returned operation ID to check later.',
					displayOptions: visible({ resource: [resource.value], operation: operations, waitForCompletion: [true] }) },
			] satisfies INodeProperties[] : [];
		}),
		{
			displayName: 'Notes View', name: name('notesView'), type: 'options', default: 'inventory',
			options: [{ name: 'Inventory Version', value: 'inventory' }, { name: 'Current Source', value: 'source' }],
			description: 'Source returns current unversioned notes with lns1_ ETags. Note bodies still require their explicit content grant.',
			displayOptions: visible({ resource: ['lead'], operation: ['notes'] }),
		},
		{
			displayName: 'Idempotency Key', name: name('idempotencyKey'), type: 'string', default: '',
			description: 'Leave empty to generate one key per execution item, reused on retries. To reconcile another execution, supply its original key and identical request. Never retry an unknown outcome with a new key.',
			displayOptions: visible({ resource: ['lead'], operation: writes }),
		},
		{
			displayName: 'Idempotency Key', name: name('idempotencyKey'), type: 'string', default: '',
			description: 'Leave empty to generate one key per execution item, reused on retries. Keep the original key to reconcile an unknown outcome; do not submit a new task request.',
			displayOptions: visible({ resource: ['task'], operation: ['create', 'complete'] }),
		},
		{
			displayName: 'Idempotency Key', name: name('idempotencyKey'), type: 'string', default: '',
			description: 'Leave empty to generate one key per execution item, reused on retries. Keep that key to reconcile an unknown outcome before creating another notification.',
			displayOptions: visible({ resource: ['notification'], operation: ['create'] }),
		},
		{
			displayName: 'Phone Number',
			name: name('phoneNumber'),
			type: 'string',
			required: true,
			default: '',
			placeholder: '+34600000000',
			description: 'Exact phone with its country prefix',
			displayOptions: visible({ resource: ['lead'], operation: ['findByPhone'] }),
		},
		{
			displayName: 'Email',
			name: name('email'),
			type: 'string',
			required: true,
			default: '',
			placeholder: 'customer@example.com',
			displayOptions: visible({ resource: ['lead'], operation: ['findByEmail'] }),
		},
		{
			displayName: 'Limit',
			name: name('limit'),
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 100 },
			default: 100,
			description: 'Max number of results to return',
			displayOptions: visible({
				resource: ['lead', 'board', 'call', 'conversation', 'booking', 'notification', 'sync'],
				operation: paged,
			}),
		},
		{
			displayName: 'Cursor',
			name: name('cursor'),
			type: 'string',
			default: '',
			description:
				'The next_cursor from the same endpoint and team. Leave empty for the first page.',
			displayOptions: visible({
				resource: ['lead', 'board', 'call', 'conversation', 'booking', 'notification', 'sync'],
				operation: paged,
			}),
		},
	];
}

export async function getTotemPublicApiTeamOptions(
	context: ILoadOptionsFunctions,
	credentialType = TOTEM_STUDIO_V2_CREDENTIAL,
) {
	const identity = await getTotemStudioV2Identity(context, credentialType);
	return identity.teams.map(({ id, label }) => ({ name: label + ' (' + id + ')', value: id }));
}

function text(value: unknown, maximum = 128): string {
	const result = cleanString(typeof value === 'string' ? value : '');
	if (
		!result ||
		result.length > maximum ||
		Array.from(result).some(
			(character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
		)
	)
		throw new TotemStudioV2ClientError('invalid_request', 400);
	return result;
}

/** Main node and compatibility alias call the same executor; runtime auth is handled elsewhere. */
export async function executeTotemPublicApi(
	context: IExecuteFunctions,
	options: PublicApiNodeOptions = {},
): Promise<INodeExecutionData[][]> {
	const output: INodeExecutionData[] = [];
	let identityPromise: Promise<TotemStudioV2Identity> | undefined;
	const getIdentity = () => {
		identityPromise ??= getTotemStudioV2Identity(context, options.credentialType);
		return identityPromise;
	};
	for (let index = 0; index < context.getInputData().length; index++) {
		let write: ReturnType<typeof preparePublicApiWrite> | undefined;
		let acceptedOperationId: string | undefined;
		try {
			const get = (name: string, fallback?: string | number | boolean) =>
				context.getNodeParameter(parameterName(name, options.prefix), index, fallback);
			const resource = options.resource ?? String(get('resource'));
			const operation = String(get('operation'));
			const registration = resolveTotemStudioV2Operation(resource, operation);
			if (!registration) throw new TotemStudioV2ClientError('invalid_request', 400);
			if (registration.kind === 'identity') {
				if (get('automationWriteContext', INHERIT_TOTEM_EXECUTION_CONTEXT) !== INHERIT_TOTEM_EXECUTION_CONTEXT)
					throw new TotemStudioV2ClientError('invalid_request', 400);
				const identity = await getIdentity();
				output.push({
					json: {
						ok: true,
						connected: true,
						integration: identity.connection,
						teams: identity.teams,
						scopes: identity.capabilities,
						...(identity.requestId ? { requestId: identity.requestId } : {}),
					},
					pairedItem: { item: index },
				});
				continue;
			}
			const selectedTeamParameter = get('teamId', '');
			const team = registration.team ? text(selectedTeamParameter) : undefined;
			if (team && !validPublicId(team, 'team'))
				throw new TotemStudioV2ClientError('invalid_request', 400);
			const id = registration.idPrefix ? text(get('recordId')) : undefined;
			if (registration.idPrefix && !validPublicId(id, registration.idPrefix))
				throw new TotemStudioV2ClientError('invalid_request', 400);
			const note = registration.note ? text(get('noteId'), 256) : undefined;
			if (note && !validPublicId(note, 'note', 256)) throw new TotemStudioV2ClientError('invalid_request', 400);
			const rawIfMatch = registration.conditional || registration.sourceCondition ? get('ifMatch', '') : undefined;
			const ifMatch = rawIfMatch === '' ? undefined : rawIfMatch;
			if (registration.conditional && !(registration.bookingAction ? validBookingActionEtag(ifMatch)
				: registration.customValues ? validCustomValuesEtag(ifMatch) : validResourceEtag(ifMatch, note ?? id)))
				throw new TotemStudioV2ClientError('invalid_request', 400);
			let body = registration.body === 'empty' ? {}
				: registration.body === 'fields' || registration.kind === 'mutation' && registration.method !== 'DELETE'
					? publicApiFields(get('fields', '{}'), context.getNode()) : undefined;
			if (resource === 'crm' && operation === 'scheduleContact') {
				const mode = get('scheduleTimeMode', 'iso');
				if (mode !== 'iso' && mode !== 'local') throw new TotemStudioV2ClientError('invalid_request', 400);
				if (mode === 'local') {
					if (!body || body.contact_at !== undefined) throw new TotemStudioV2ClientError('invalid_request', 400);
					const part = (value: string) => {
						const raw = get(value, '');
						if (typeof raw !== 'number' && typeof raw !== 'string') throw new TotemStudioV2ClientError('invalid_request', 400);
						return raw;
					};
					const zone = get('contactTimezone', '');
					if (typeof zone !== 'string') throw new TotemStudioV2ClientError('invalid_request', 400);
					const composed = composeContactAtMs({ year: part('contactYear'), month: part('contactMonth'), day: part('contactDay'), hour: part('contactHour'), minute: part('contactMinute'), timezone: zone });
					if (!composed.ok) throw new TotemStudioV2ClientError('invalid_request', 400);
					body = { ...body, contact_at: new Date(composed.ms).toISOString() };
				}
			}
			if (registration.sourceCondition && ifMatch !== undefined && !validSourceEtag(ifMatch, body?.lead_id))
				throw new TotemStudioV2ClientError('invalid_request', 400);
			if (registration.kind === 'knowledge') {
				const query = get('knowledgeQuery', '');
				const maximum = Number(get('maxResults', 4));
				if (typeof query !== 'string' || !query.trim() || query.trim().length > 1_000
					|| !Number.isInteger(maximum) || maximum < 1 || maximum > 8)
					throw new TotemStudioV2ClientError('invalid_request', 400);
				body = { query: query.trim(), max_results: maximum };
			}
			const wait = registration.kind === 'operation' && registration.endpoint ? get('waitForCompletion', false) : false;
			const maxWaitSeconds = wait === true ? Number(get('maxWaitSeconds', 20)) : 20;
			if (typeof wait !== 'boolean' || wait && (!Number.isInteger(maxWaitSeconds) || maxWaitSeconds < 1 || maxWaitSeconds > 60))
				throw new TotemStudioV2ClientError('invalid_request', 400);
			const intent = { resource, operation, ...(team ? { team } : {}), ...(id ? { id } : {}), ...(note ? { note } : {}), ...(ifMatch ? { ifMatch } : {}), ...(body ? { body } : {}) };
			if (registration.kind === 'mutation' || registration.idempotency)
				preflightPublicApiWrite(context, index, intent, get('idempotencyKey', ''));
			let value: string | undefined;
			if (registration.kind === 'search') {
				value = text(get(operation === 'findByPhone' ? 'phoneNumber' : 'email'), 254);
				if (operation === 'findByPhone') {
					value = value.replace(/[().\s-]/gu, '');
					if (!/^\+?[0-9]{5,15}$/u.test(value))
						throw new TotemStudioV2ClientError('invalid_request', 400);
				} else {
					value = value.toLowerCase();
					if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))
						throw new TotemStudioV2ClientError('invalid_request', 400);
				}
			}
			let query: IDataObject | undefined;
			if (['list', 'activities', 'feed'].includes(registration.kind)) {
				const limit = Number(get('limit', 100));
				const cursor = get('cursor', '');
				if (
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > 100 ||
					typeof cursor !== 'string' ||
					cursor.length > 8192
				)
					throw new TotemStudioV2ClientError('invalid_request', 400);
				query = { limit, ...(cursor ? { cursor } : {}) };
				if (resource === 'lead' && operation === 'notes') {
					const view = get('notesView', 'inventory');
					if (view !== 'inventory' && view !== 'source') throw new TotemStudioV2ClientError('invalid_request', 400);
					if (view === 'source') query.view = 'source';
				}
			}
			const identity = await getIdentity();
			const selectedExecutionTeam = identity.principalKind === 'automation_service' && !registration.team && selectedTeamParameter !== '' && selectedTeamParameter !== undefined
				? text(selectedTeamParameter) : team;
			const executionAuthority = resolvePublicApiExecutionContext(context, index,
				get('automationWriteContext', INHERIT_TOTEM_EXECUTION_CONTEXT), identity, selectedExecutionTeam);
			if (registration.kind === 'mutation' || registration.idempotency)
				write = preparePublicApiWrite(context, index, intent, get('idempotencyKey', ''), executionAuthority);
			let response = await executeTotemStudioV2Operation(
				context,
				{
					resource,
					operation,
					identity,
					...(executionAuthority ? { executionAuthority } : {}),
					...(team ? { team } : {}),
					...(id ? { id } : {}),
					...(value ? { value } : {}),
					...(query ? { query } : {}),
					...(note ? { note } : {}),
					...(body ? { body } : {}),
					...(write ? { idempotencyKey: write.key } : {}),
					...(typeof ifMatch === 'string' ? { ifMatch } : {}),
				},
				options.credentialType,
			);
			if (response.data.object === 'operation' && validPublicId(response.data.id, 'op')) acceptedOperationId = response.data.id;
			let observation: PublicApiOperationObservation | undefined;
			if (wait && acceptedOperationId) {
				const waited = await waitForPublicApiOperation(response, { maxWaitSeconds,
					read: (id, observationTimeoutMs) => executeTotemStudioV2Operation(context, { resource: 'operation', operation: 'get', id, identity,
						observationTimeoutMs, ...(team ? { team } : {}), ...(executionAuthority ? { executionAuthority } : {}) }, options.credentialType) });
				response = waited;
				observation = waited.observation;
			}
			const read = async (resource: 'library' | 'attachment', operation: 'prepared' | 'resolve', reference: string) => {
				const selectedTeam = team ?? executionAuthority?.apiTeamId;
				if (!selectedTeam) throw new TotemStudioV2ClientError('capability_denied', 403);
				return (await executeTotemStudioV2Operation(context, { resource, operation, identity, team: selectedTeam, body: { reference },
					...(executionAuthority ? { executionAuthority } : {}) }, options.credentialType)).data;
			};
			const visitorResponse: PublicVisitorResponse | undefined = response.data.object === 'library_prepared_response'
				? await formatPreparedVisitorResponse(response.data, reference => read('attachment', 'resolve', reference))
				: await resolvePreparedVisitorResponse(response.data.object === 'operation' ? response.data.result : undefined,
					{ prepared: reference => read('library', 'prepared', reference), attachment: reference => read('attachment', 'resolve', reference) });
			output.push({
				json: {
					...response.data,
					ok: true,
					...(response.requestId ? { requestId: response.requestId } : {}),
					...(response.etag ? { etag: response.etag } : {}),
					...(write ? { idempotencyKey: write.key } : {}),
					...(observation ? { observation: { status: observation.status, code: observation.code } } : {}),
					...(visitorResponse ? { visitorResponse: visitorResponse as unknown as IDataObject } : {}),
				},
				pairedItem: { item: index },
			});
		} catch (error) {
			const safeError = error instanceof PreparedVisitorResponseError ? new TotemStudioV2ClientError('gateway_contract_error')
				: totemStudioV2ErrorCause(error) ?? new TotemStudioV2ClientError('gateway_unavailable', undefined, true);
			if (write && safeError.code === 'outcome_unknown') write.unknown = true;
			const result = buildTotemStudioV2ErrorResult(safeError);
			if (write) result.idempotencyKey = write.key;
			if (acceptedOperationId) result.operationId = acceptedOperationId;
			if (shouldContinueOnError(context)) {
				output.push({ json: result, pairedItem: { item: index } });
				continue;
			}
			const message = String(result.message) + (result.idempotencyKey ? ` Idempotency key: ${String(result.idempotencyKey)}` : '');
			throw new NodeOperationError(context.getNode(), safeError, { itemIndex: index, message });
		}
	}
	return [output];
}
