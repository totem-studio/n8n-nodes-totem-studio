export interface TotemStudioV2OperationRegistration {
	resource: string;
	operation: string;
	name: string;
	path: string;
	scope: string | readonly string[];
	kind: 'identity' | 'search' | 'knowledge' | 'list' | 'dictionary' | 'detail' | 'activities' | 'feed' | 'mutation' | 'operation' | 'business';
	idPrefix?: string;
	team?: boolean;
	method?: 'POST' | 'PATCH' | 'DELETE';
	note?: boolean;
	conditional?: boolean;
	/** Optional reviewed source-lead validator for a canonical business write. */
	sourceCondition?: boolean;
	/** Separate content contract and snapshot validator, independent of the lead ETag. */
	customValues?: boolean;
	/** Durable task actions use a stable key; cancellation does not. */
	idempotency?: boolean;
	body?: 'fields' | 'empty';
	/** Business operation accepted asynchronously; absent on status/cancel routes. */
	endpoint?: 'tasks.create' | 'tasks.complete' | 'notifications.create' | 'bookings.create' | 'bookings.cancel' | 'bookings.reschedule'
		| 'assistants.run' | 'quotes.recordOutcome' | 'calls.start' | 'bookingPayments.sendLink' | 'messages.send' | 'messages.prepareReply' | 'messages.requestInfo' | 'library.send' | 'catalog.send';
	/** Fixed read contract; never an arbitrary route or operation supplied by a model. */
	apiOperation?: 'call.analysis.update' | 'meeting.analysis.update' | 'booking_services.options' | 'assistants.options' | 'leads.scheduleContact' | 'leads.handoff' | 'referrals.create' | 'calls.options' | 'calls.transcript' | 'calls.recording' | 'crm.context' | 'messages.channels' | 'conversations.messages' | 'bookings.availability' | 'bookings.inspect' | 'bookings.forLead'
		| 'bookingPayments.get' | 'library.list' | 'library.get' | 'library.prepared' | 'attachments.resolve' | 'catalog.search';
	/** Management actions require bka_ rather than a versioned inventory ETag. */
	bookingAction?: boolean;
	/** General invocation/discovery belongs to recipient tenant integrations, never a hosted assistant's source. */
	tenantOnly?: boolean;
}

/** Explicit API operations shared by every distribution and saved public alias. */
export const TOTEM_STUDIO_V2_OPERATIONS: readonly TotemStudioV2OperationRegistration[] = [
	{ resource: 'bookingService', operation: 'options', name: 'Discover Current Services', path: '/booking_services/options', scope: 'calendar:availability:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'booking_services.options' },
	{ resource: 'call', operation: 'updateAnalysis', name: 'Complete Dispatched System Analysis', path: '/calls/{id}/analysis', scope: 'calls:analysis:write', kind: 'business', method: 'PATCH', team: true, body: 'fields', idPrefix: 'call', idempotency: true, apiOperation: 'call.analysis.update' },
	{ resource: 'booking', operation: 'updateAnalysis', name: 'Complete Dispatched Meeting Analysis', path: '/bookings/{id}/analysis', scope: 'calendar:analysis:write', kind: 'business', method: 'PATCH', team: true, body: 'fields', idPrefix: 'bkg', idempotency: true, apiOperation: 'meeting.analysis.update' },
	{ resource: 'assistant', operation: 'options', name: 'Discover Published Assistants', path: '/assistants/options', scope: 'assistants:run', kind: 'business', method: 'POST', team: true, body: 'empty', apiOperation: 'assistants.options', tenantOnly: true },
	{ resource: 'assistant', operation: 'run', name: 'Run Published Assistant', path: '/assistants/runs', scope: 'assistants:run', kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'assistants.run', tenantOnly: true },
	{ resource: 'quote', operation: 'recordOutcome', name: 'Record Attested External Quote Outcome', path: '/crm/quote-outcomes', scope: 'quotes:write', kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'quotes.recordOutcome' },
	{ resource: 'crm', operation: 'scheduleContact', name: 'Schedule Confirmed Contact', path: '/crm/scheduled-contact', scope: ['crm:write', 'crm:scheduled_contacts:write'], kind: 'business', method: 'POST', team: true, body: 'fields', idempotency: true, apiOperation: 'leads.scheduleContact', sourceCondition: true },
	{ resource: 'crm', operation: 'handoff', name: 'Handoff to Configured Family Office', path: '/crm/handoff', scope: ['crm:write', 'crm:handoff:write'], kind: 'business', method: 'POST', team: true, body: 'fields', idempotency: true, apiOperation: 'leads.handoff' },
	{ resource: 'referral', operation: 'create', name: 'Refer to Totem Studio', path: '/referrals/totem', scope: 'referrals:write', kind: 'business', method: 'POST', team: true, body: 'fields', idempotency: true, apiOperation: 'referrals.create' },
	{ resource: 'call', operation: 'options', name: 'Get Current Calling Bindings', path: '/calls/options', scope: 'calls:write', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'calls.options' },
	{ resource: 'call', operation: 'start', name: 'Start Consented Outgoing Call', path: '/calls', scope: 'calls:write', kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'calls.start' },
	{ resource: 'call', operation: 'transcript', name: 'Read Authorized Transcript', path: '/calls/{id}/transcript', scope: 'calls:transcripts:read', kind: 'business', idPrefix: 'call', apiOperation: 'calls.transcript' },
	{ resource: 'call', operation: 'recording', name: 'Resolve Authorized Recording', path: '/calls/{id}/recording', scope: 'calls:recordings:read', kind: 'business', idPrefix: 'call', apiOperation: 'calls.recording' },
	{ resource: 'crm', operation: 'context', name: 'Get Current Context', path: '/crm/context', scope: 'crm:context:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'crm.context' },
	{ resource: 'message', operation: 'channels', name: 'Get Configured Senders', path: '/messages/channels', scope: 'messages:send', kind: 'business', method: 'POST', team: true, body: 'empty', apiOperation: 'messages.channels' },
	{ resource: 'message', operation: 'prepareReply', name: 'Prepare Canonical First Reply', path: '/messages/prepare-reply', scope: ['messages:send', 'messages:content:read', 'library:read'], kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'messages.prepareReply' },
	{ resource: 'message', operation: 'send', name: 'Send', path: '/messages/send', scope: 'messages:send', kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'messages.send' },
	{ resource: 'message', operation: 'requestInfo', name: 'Queue Staff-Configured Information', path: '/messages/requested-info', scope: 'messages:send', kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'messages.requestInfo' },
	{ resource: 'conversation', operation: 'messages', name: 'Get Current Message Content', path: '/conversations/messages', scope: 'messages:content:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'conversations.messages' },
	{ resource: 'booking', operation: 'availability', name: 'Get Current Availability', path: '/bookings/availability', scope: 'calendar:availability:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'bookings.availability' },
	{ resource: 'booking', operation: 'inspect', name: 'Inspect for Management', path: '/bookings/{id}/management', scope: 'calendar:write', kind: 'business', idPrefix: 'bkg', apiOperation: 'bookings.inspect' },
	{ resource: 'booking', operation: 'forLead', name: 'Get Current Lead Bookings', path: '/bookings/for-lead', scope: 'calendar:write', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'bookings.forLead' },
	{ resource: 'booking', operation: 'create', name: 'Book Reviewed Offer', path: '/bookings', scope: 'calendar:write', kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'bookings.create' },
	{ resource: 'booking', operation: 'cancel', name: 'Cancel Reviewed Booking', path: '/bookings/{id}/cancel', scope: 'calendar:write', kind: 'operation', method: 'POST', body: 'empty', idPrefix: 'bkg', conditional: true, bookingAction: true, idempotency: true, endpoint: 'bookings.cancel' },
	{ resource: 'booking', operation: 'reschedule', name: 'Move Reviewed Booking', path: '/bookings/{id}/reschedule', scope: 'calendar:write', kind: 'operation', method: 'POST', body: 'fields', idPrefix: 'bkg', conditional: true, bookingAction: true, idempotency: true, endpoint: 'bookings.reschedule' },
	{ resource: 'bookingPayment', operation: 'get', name: 'Get Current Payments', path: '/booking-payments/get', scope: 'calendar:payments:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'bookingPayments.get' },
	{ resource: 'bookingPayment', operation: 'sendLink', name: 'Send Confirmed Payment Link', path: '/booking-payments/send-link', scope: ['calendar:payment_links:send', 'messages:send'], kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'bookingPayments.sendLink' },
	{ resource: 'library', operation: 'list', name: 'Discover', path: '/library/list', scope: 'library:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'library.list' },
	{ resource: 'library', operation: 'get', name: 'Get Reviewed Entry', path: '/library/get', scope: 'library:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'library.get' },
	{ resource: 'library', operation: 'prepared', name: 'Get Prepared Visitor Response', path: '/library/prepared', scope: 'library:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'library.prepared' },
	{ resource: 'library', operation: 'send', name: 'Send Reviewed Entry', path: '/library/send', scope: ['library:read', 'messages:send'], kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'library.send' },
	{ resource: 'attachment', operation: 'resolve', name: 'Resolve Authorized Attachment', path: '/attachments/resolve', scope: ['library:read', 'attachments:read'], kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'attachments.resolve' },
	{ resource: 'catalog', operation: 'search', name: 'Search Published Catalog', path: '/catalog/search', scope: 'catalog:read', kind: 'business', method: 'POST', team: true, body: 'fields', apiOperation: 'catalog.search' },
	{ resource: 'catalog', operation: 'send', name: 'Send Reviewed Selection', path: '/catalog/send', scope: ['catalog:read', 'messages:send'], kind: 'operation', method: 'POST', team: true, body: 'fields', idempotency: true, endpoint: 'catalog.send' },
	{
		resource: 'knowledge', operation: 'search', name: 'Search', path: '/knowledge/search',
		scope: 'knowledge:read', kind: 'knowledge', method: 'POST', team: true,
	},
	{
		resource: 'connection',
		operation: 'whoAmI',
		name: 'Validate Connection',
		path: '/me',
		scope: '',
		kind: 'identity',
	},
	{
		resource: 'team',
		operation: 'list',
		name: 'Get Many',
		path: '/teams',
		scope: 'teams:read',
		kind: 'dictionary',
	},
	{
		resource: 'team',
		operation: 'get',
		name: 'Get',
		path: '/teams/{id}',
		scope: 'teams:read',
		kind: 'detail',
		idPrefix: 'team',
	},
	{
		resource: 'lead',
		operation: 'findByPhone',
		name: 'Find by Phone',
		path: '/leads/search',
		scope: 'crm:read',
		kind: 'search',
		team: true,
	},
	{
		resource: 'lead',
		operation: 'findByEmail',
		name: 'Find by Email',
		path: '/leads/search',
		scope: 'crm:read',
		kind: 'search',
		team: true,
	},
	{
		resource: 'lead',
		operation: 'list',
		name: 'Get Many',
		path: '/leads',
		scope: 'crm:read',
		kind: 'list',
		team: true,
	},
	{
		resource: 'lead',
		operation: 'get',
		name: 'Get',
		path: '/leads/{id}',
		scope: 'crm:read',
		kind: 'detail',
		idPrefix: 'lead',
	},
	{
		resource: 'lead',
		operation: 'activities',
		name: 'Get Activities',
		path: '/leads/{id}/activities',
		scope: 'crm:read',
		kind: 'activities',
		idPrefix: 'lead',
	},
	{
		resource: 'lead', operation: 'notes', name: 'Get Notes', path: '/leads/{id}/notes',
		scope: 'crm:notes:read', kind: 'activities', idPrefix: 'lead',
	},
	{
		resource: 'lead', operation: 'getCustomValues', name: 'Get Custom Values', path: '/leads/{id}/custom-values',
		scope: 'crm:custom_values:read', kind: 'detail', idPrefix: 'lead', customValues: true,
	},
	{
		resource: 'lead', operation: 'updateCustomValues', name: 'Update Custom Values', path: '/leads/{id}/custom-values',
		scope: 'crm:custom_values:write', kind: 'mutation', method: 'PATCH', idPrefix: 'lead', conditional: true, customValues: true,
	},
	{
		resource: 'lead', operation: 'upsert', name: 'Create or Resolve', path: '/leads',
		scope: 'crm:write', kind: 'mutation', method: 'POST', team: true,
	},
	{
		resource: 'lead', operation: 'update', name: 'Update', path: '/leads/{id}',
		scope: 'crm:write', kind: 'mutation', method: 'PATCH', idPrefix: 'lead', conditional: true,
	},
	{
		resource: 'lead', operation: 'archive', name: 'Archive', path: '/leads/{id}/archive',
		scope: 'crm:write', kind: 'mutation', method: 'POST', idPrefix: 'lead', conditional: true,
	},
	{
		resource: 'lead', operation: 'addNote', name: 'Add Note', path: '/leads/{id}/notes',
		scope: 'crm:write', kind: 'mutation', method: 'POST', idPrefix: 'lead',
	},
	{
		resource: 'lead', operation: 'updateNote', name: 'Update Note', path: '/leads/{id}/notes/{note}',
		scope: 'crm:write', kind: 'mutation', method: 'PATCH', idPrefix: 'lead', note: true, conditional: true,
	},
	{
		resource: 'lead', operation: 'deleteNote', name: 'Delete Note', path: '/leads/{id}/notes/{note}',
		scope: 'crm:write', kind: 'mutation', method: 'DELETE', idPrefix: 'lead', note: true, conditional: true,
	},
	{
		resource: 'task', operation: 'create', name: 'Create', path: '/tasks',
		scope: 'tasks:write', kind: 'operation', method: 'POST', team: true, idempotency: true, body: 'fields',
		endpoint: 'tasks.create',
	},
	{
		resource: 'task', operation: 'complete', name: 'Complete', path: '/tasks/{id}/complete',
		scope: 'tasks:write', kind: 'operation', method: 'POST', team: true, idPrefix: 'task', idempotency: true, body: 'empty',
		endpoint: 'tasks.complete',
	},
	{
		resource: 'operation', operation: 'get', name: 'Get', path: '/operations/{id}',
		scope: [], kind: 'operation', team: true, idPrefix: 'op',
	},
	{
		resource: 'operation', operation: 'cancel', name: 'Cancel', path: '/operations/{id}/cancel',
		scope: [], kind: 'operation', method: 'POST', team: true, idPrefix: 'op', body: 'empty',
	},
	{
		resource: 'notification', operation: 'create', name: 'Create', path: '/notifications',
		scope: 'notifications:write', kind: 'operation', method: 'POST', team: true, idempotency: true, body: 'fields',
		endpoint: 'notifications.create',
	},
	{
		resource: 'notification', operation: 'list', name: 'Get Many', path: '/notifications',
		scope: 'crm:read', kind: 'list', team: true,
	},
	{
		resource: 'notification', operation: 'get', name: 'Get', path: '/notifications/{id}',
		scope: 'crm:read', kind: 'detail', idPrefix: 'ntf',
	},
	{
		resource: 'board',
		operation: 'list',
		name: 'Get Many',
		path: '/boards',
		scope: 'crm:read',
		kind: 'list',
		team: true,
	},
	{
		resource: 'call',
		operation: 'list',
		name: 'Get Many',
		path: '/calls',
		scope: 'calls:read',
		kind: 'list',
		team: true,
	},
	{
		resource: 'call',
		operation: 'get',
		name: 'Get',
		path: '/calls/{id}',
		scope: 'calls:read',
		kind: 'detail',
		idPrefix: 'call',
	},
	{
		resource: 'conversation',
		operation: 'list',
		name: 'Get Many',
		path: '/conversations',
		scope: 'messages:read',
		kind: 'list',
		team: true,
	},
	{
		resource: 'conversation',
		operation: 'get',
		name: 'Get',
		path: '/conversations/{id}',
		scope: 'messages:read',
		kind: 'detail',
		idPrefix: 'conv',
	},
	{
		resource: 'booking',
		operation: 'list',
		name: 'Get Many',
		path: '/bookings',
		scope: 'calendar:read',
		kind: 'list',
		team: true,
	},
	{
		resource: 'booking',
		operation: 'get',
		name: 'Get',
		path: '/bookings/{id}',
		scope: 'calendar:read',
		kind: 'detail',
		idPrefix: 'bkg',
	},
	{
		resource: 'member',
		operation: 'list',
		name: 'Get Many',
		path: '/members',
		scope: 'teams:read',
		kind: 'dictionary',
		team: true,
	},
	{
		resource: 'bookingService',
		operation: 'list',
		name: 'Get Many',
		path: '/booking_services',
		scope: 'calendar:read',
		kind: 'dictionary',
		team: true,
	},
	{
		resource: 'sync',
		operation: 'changes',
		name: 'Get Changes',
		path: '/sync/changes',
		scope: 'crm:read',
		kind: 'feed',
		team: true,
	},
];

export function resolveTotemStudioV2Operation(
	resource: string,
	operation: string,
): TotemStudioV2OperationRegistration | undefined {
	return TOTEM_STUDIO_V2_OPERATIONS.find(
		(registration) => registration.resource === resource && registration.operation === operation,
	);
}
