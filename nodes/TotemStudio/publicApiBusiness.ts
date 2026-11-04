/** Closed current-source business contracts for the shared public node. Inputs never choose routes, actors or raw destinations. */
import type { IDataObject } from 'n8n-workflow';
import { validPreparedAttachmentUrl, projectPreparedVisitorDescriptor } from './publicPreparedResponse';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (max: number, min = 0) => (value: unknown): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
const literal = (expected: string | boolean) => (value: unknown) => value === expected;
const one = (...values: string[]) => (value: unknown) => typeof value === 'string' && values.includes(value);
const array = (check: (value: unknown) => boolean, maximum: number, minimum = 0) => (value: unknown) => Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every(check);
const nullable = (check: (value: unknown) => boolean) => (value: unknown) => value === null || check(value);
const opaque = (prefix: string) => (value: unknown) => string(256, 1)(value) && new RegExp(`^${prefix}_[A-Za-z0-9]+$`, 'u').test(value);
const reference = (prefix: 'tcal1' | 'tcnt1' | 'tcall1' | 'tast1') => (value: unknown) => string(16_384, 40)(value) && new RegExp(`^${prefix}\\.[A-Za-z0-9_-]+$`, 'u').test(value);
const instant = (value: unknown) => string(40, 20)(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value));
const sourceEtag = (prefix: 'lrs1' | 'lns1' | 'bka') => (value: unknown) => typeof value === 'string' && new RegExp(`^"${prefix}_[a-f0-9]{64}"$`, 'u').test(value);
function shape(value: unknown, fields: Record<string, (value: unknown) => boolean>, required: string[] = []): value is Record<string, unknown> {
	return record(value) && required.every(key => Object.prototype.hasOwnProperty.call(value, key))
		&& Object.keys(value).every(key => Object.prototype.hasOwnProperty.call(fields, key) && fields[key]!(value[key]));
}
const content = reference('tcnt1'), calendar = reference('tcal1'), lead = opaque('lead'), conversation = opaque('conv');
const familyRouting = nullable(value => shape(value, { instruction: nullable(string(100_000)), offices: array(office => shape(office, {
	office: string(128), name: nullable(string(100_000)), coverage: nullable(string(100_000)), preferred_language: nullable(string(100_000)),
	boards: array(board => shape(board, { id: opaque('brd'), name: nullable(string(100_000)), is_default: boolean }, ['id', 'name', 'is_default']), 100),
}, ['office', 'name', 'coverage', 'preferred_language', 'boards']), 50) }, ['instruction', 'offices']));
const names = (key: (value: string) => boolean, value: (value: unknown) => boolean) => (input: unknown) => record(input)
	&& Object.keys(input).length <= 100 && Object.entries(input).every(([name, field]) => key(name) && value(field));
const variables = names(key => key.length > 0 && key.length <= 100, string(2_000, 1));
function messageBody(value: unknown, hosted: boolean): boolean {
	if (!shape(value, { target: record, content: record }, ['target', 'content'])) return false;
	const target = value.target as Record<string, unknown>, item = value.content as Record<string, unknown>;
	const selected = target.kind === 'conversation'
		? shape(target, { kind: literal('conversation'), conversation_id: conversation }, hosted ? ['kind'] : ['kind', 'conversation_id'])
		: shape(target, { kind: literal('lead'), lead_id: lead, channel_reference: field => string(69, 69)(field) && /^mch1_[a-f0-9]{64}$/u.test(field) }, ['kind', 'lead_id', 'channel_reference']);
	if (!selected) return false;
	if (item.kind === 'text') return shape(item, { kind: literal('text'), text: string(20_000, 1), subject: string(998) }, ['kind', 'text']);
	if (item.kind === 'whatsapp_call') {
		const text = (value: unknown) => string(1_024, 1)(value) && value.trim().length > 0;
		return item.action === 'send_call_button'
			? shape(item, {kind: literal('whatsapp_call'), action: literal('send_call_button'), body_text: text,
				display_text: value => string(20, 1)(value) && value.trim().length > 0, ttl_minutes: integer(1, 43_200)}, ['kind', 'action', 'body_text'])
			: shape(item, {kind: literal('whatsapp_call'), action: literal('request_permission'), body_text: text}, ['kind', 'action']);
	}
	if (item.kind === 'library') return shape(item, { kind: literal('library'), asset_reference: content, caption: string(2_000) }, ['kind', 'asset_reference']);
	return shape(item, { kind: literal('template'), template_name: field => string(512, 1)(field) && /^[a-z0-9_]+$/u.test(field),
		language: field => string(20, 2)(field) && /^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(field), parameter_format: one('NAMED', 'POSITIONAL'),
		variable_values: array(string(2_000, 1), 100), variable_values_map: variables,
		url_button_values: names(key => /^[0-9]$/u.test(key), string(2_000, 1)), consent_confirmed: literal(true) }, ['kind', 'template_name', 'language', 'consent_confirmed']);
}

export function validBusinessRequest(operation: string, value: unknown, hosted: boolean): boolean {
	switch (operation) {
		case 'booking_services.options': return shape(value, { query: string(200), limit: integer(1, 50), cursor: content });
		case 'call.analysis.update': return shape(value, { summary: string(5_000),
			custom_values: field => names(key => string(100, 1)(key), item => item === null || string(2_000)(item) || boolean(item) || typeof item === 'number' && Number.isFinite(item))(field) && record(field) && Object.keys(field).length <= 50,
			finite_fields: field => array(one('user_sentiment', 'call_successful', 'in_voicemail'), 3, 1)(field) && new Set(field as unknown[]).size === (field as unknown[]).length })
			&& Object.keys(value).length > 0 && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32_000;
		case 'meeting.analysis.update': return shape(value, { summary: string(8_000), sentiment: string(120) })
			&& Object.keys(value).length > 0 && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32_000;
		case 'assistants.options': return shape(value, {});
		case 'assistants.run': return shape(value, { reference: reference('tast1'), message: string(4_000, 1), conversation_id: conversation }, ['reference', 'message']);
		case 'quotes.recordOutcome': return shape(value, { lead_id: lead, conversation_id: conversation, call_id: opaque('call'),
			quote_reference: field => string(256, 1)(field) && !field.includes('/'), quote_revision_hash: field => string(64, 64)(field) && /^[a-f0-9]{64}$/u.test(field),
			quoted: boolean, reason: one('BELOW_MINIMUM', 'BELOW_MINIMUM_REQUIRES_REVIEW', 'ABOVE_MAXIMUM', 'ABOVE_MAXIMUM_REQUIRES_REVIEW', 'PERSONAL_STUDY_REQUIRED'), summary: string(1_500),
			deliveries: array(field => shape(field, { channel: one('email', 'whatsapp'), external_receipt: receipt => string(256, 1)(receipt) && !receipt.includes('/'), accepted_at: instant }, ['channel', 'external_receipt', 'accepted_at']), 2) },
		['quote_reference', 'quote_revision_hash', 'quoted']) && !(value.conversation_id && value.call_id);
		case 'leads.scheduleContact': return shape(value, { lead_id: lead, new_contact: field => shape(field, { name: string(100, 1), phone: string(80, 1) }, ['name', 'phone']),
			contact_at: instant, channel: one('call', 'whatsapp'), note: string(500), customer_confirmed: literal(true) }, ['contact_at', 'channel', 'customer_confirmed'])
			&& !(value.lead_id && value.new_contact);
		case 'leads.handoff': return shape(value, { lead_id: lead, office: string(128, 1), board_id: opaque('brd'), summary: string(4_000, 1), name: string(200), phone: string(80), email: string(254, 1) }, hosted ? ['summary'] : ['lead_id', 'summary']);
		case 'referrals.create': return shape(value, { name: string(200, 1), phone: field => string(16, 8)(field) && /^\+[1-9][0-9]{6,14}$/u.test(field),
			note: string(5_000, 1), tags: array(string(100, 1), 50), consent: literal(true), lead_id: lead }, hosted ? ['name', 'note', 'consent'] : ['name', 'phone', 'note', 'consent']);
		case 'calls.options': return shape(value, { lead_id: lead }, ['lead_id']);
		case 'calls.start': return shape(value, { lead_id: lead, binding_reference: reference('tcall1'), consent_confirmed: literal(true), objective: string(4_000) }, ['lead_id', 'binding_reference', 'consent_confirmed']);
		case 'calls.transcript': case 'calls.recording': return value === undefined;
		case 'crm.context': return shape(value, { lead_id: lead, conversation_id: conversation, include_notes: boolean, include_custom_values: boolean,
			include_messages: boolean, include_calls: boolean, include_payments: boolean, include_recordings: boolean, include_attachments: boolean, representation: literal('model') });
		case 'messages.channels': case 'bookings.cancel': return shape(value, {});
		case 'messages.send': return messageBody(value, hosted);
		case 'messages.prepareReply': return shape(value, { conversation_id: conversation }, hosted ? [] : ['conversation_id']);
		case 'notifications.create': return shape(value, { note: text => string(5_000, 1)(text) && text.trim().length > 0,
			title: text => string(200, 1)(text) && text.trim().length > 0, lead_id: lead,
			department_id: text => string(128, 1)(text) && text.trim().length > 0, notify: boolean, status: one('new', 'archived'),
			handoff_reason: literal('missed_team_appointment') }, ['note'])
			&& (hosted || value.handoff_reason === undefined || lead(value.lead_id));
		case 'messages.requestInfo': return shape(value, { lead_id: lead, info: string(500, 1) }, hosted ? ['info'] : ['lead_id', 'info']);
		case 'conversations.messages': return shape(value, { conversation_id: conversation, limit: integer(1, 50) }, hosted ? [] : ['conversation_id']);
		case 'bookings.availability': return shape(value, { lead_id: lead, service_id: opaque('svc'), option: calendar, from_at: instant, to_at: instant,
			additional_services: array(row => shape(row, { service_id: opaque('svc'), option: calendar }, ['service_id']), 4, 1),
			party_size: integer(1, 10_000), resource_units: integer(1, 10_000), booking_page: string(160, 1) }, ['lead_id', 'service_id']);
		case 'bookings.forLead': return shape(value, { lead_id: lead, from_at: instant, to_at: instant }, ['lead_id']);
		case 'bookings.create': return shape(value, { lead_id: lead, offer: calendar, customer_name: string(300, 1), notes: string(10_000), payment_reference: calendar }, ['lead_id', 'offer', 'customer_name']);
		case 'bookings.reschedule': return shape(value, { starts_at: instant }, ['starts_at']);
		case 'bookingPayments.get': return shape(value, { lead_id: lead, reference: calendar }, ['lead_id']);
		case 'bookingPayments.sendLink': return shape(value, { lead_id: lead, reference: calendar, consent_confirmed: literal(true) }, ['lead_id', 'reference', 'consent_confirmed']);
		case 'library.list': return shape(value, { query: string(500), type: one('message', 'media', 'sequence'), language: string(35), cursor: content, limit: integer(1, 50) });
		case 'library.get': case 'library.prepared': case 'attachments.resolve': return shape(value, { reference: content }, ['reference']);
		case 'library.send': return shape(value, { reference: content, expected_revision: integer(0), conversation_id: conversation, caption: string(4_000) },
			hosted ? ['reference', 'expected_revision'] : ['reference', 'expected_revision', 'conversation_id']);
		case 'catalog.search': return shape(value, { catalog: content, query: string(500), requested_start: instant, party_size: integer(1, 10_000) });
		case 'catalog.send': return shape(value, { catalog: content, variants: field => array(content, 30, 1)(field) && new Set(field as unknown[]).size === (field as unknown[]).length,
			expected_revision: integer(0), conversation_id: conversation, body_text: string(1_024) }, hosted ? ['catalog', 'variants', 'expected_revision'] : ['catalog', 'variants', 'expected_revision', 'conversation_id']);
		default: return true;
	}
}

const copy = (value: Record<string, unknown>, keys: string[]): IDataObject => Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, value[key]])) as IDataObject;
export function validBookingActionEtag(value: unknown): value is string { return sourceEtag('bka')(value); }
export function validSourceEtag(value: unknown, id: unknown): value is string {
	return typeof id === 'string' && (id.startsWith('lead_') ? sourceEtag('lrs1')(value) : id.startsWith('note_') && sourceEtag('lns1')(value));
}

/** Metadata source receipts remain content-free even for a write-only key. */
export function projectSourceMutation(data: IDataObject, id?: string, noteId?: string): IDataObject | undefined {
	if (data.object === 'lead_source_mutation') {
		if (typeof data.created !== 'boolean' || typeof data.changed !== 'boolean' || data.registered_lead_linked !== undefined && !boolean(data.registered_lead_linked) || !(data.lead === null || record(data.lead)
			&& data.lead.object === 'lead_source_receipt' && lead(data.lead.id) && (!id || data.lead.id === id)
			&& sourceEtag('lrs1')(data.lead.etag) && instant(data.lead.updated_at))) return undefined;
		return { object: 'lead_source_mutation', created: data.created, changed: data.changed,
			...(data.registered_lead_linked !== undefined ? { registered_lead_linked: data.registered_lead_linked } : {}),
			lead: data.lead === null ? null : copy(data.lead as Record<string, unknown>, ['object', 'id', 'etag', 'updated_at']) };
	}
	if (data.object !== 'lead_note_source_mutation' || typeof data.created !== 'boolean' || typeof data.deleted !== 'boolean' || !record(data.note)
		|| !opaque('note')(data.note.id) || data.note.lead !== id || noteId && data.note.id !== noteId) return undefined;
	if (data.deleted ? data.note.object !== 'lead_note_source_deletion'
		: data.note.object !== 'lead_note_source_receipt' || !sourceEtag('lns1')(data.note.etag) || !instant(data.note.updated_at)) return undefined;
	return { object: 'lead_note_source_mutation', created: data.created, deleted: data.deleted,
		note: copy(data.note, data.deleted ? ['object', 'id', 'lead'] : ['object', 'id', 'lead', 'etag', 'updated_at']) };
}

function calendarServiceOption(value: unknown): boolean {
	return shape(value, { service_id: opaque('svc'), name: string(500), when_to_use: string(8_000), meeting_type: one('online', 'in_person', 'phone'),
		duration_minutes: integer(1), min_notice_minutes: integer(0), horizon_days: integer(1),
		options: array(option => shape(option, { label: string(500), duration_minutes: integer(1), when_to_use: string(8_000),
			payment: payment => shape(payment, { mode: one('none', 'link', 'required', 'unavailable'), amount_minor: nullable(integer(1)), currency: nullable(string(3)),
				basis: nullable(one('per_booking', 'per_person', 'per_resource_unit')) }, ['mode', 'amount_minor', 'currency', 'basis']) }, ['label', 'duration_minutes', 'when_to_use', 'payment']), 50),
		booking_pages: array(page => shape(page, { title: string(500), url: nullable(address => string(2_048, 1)(address)
			&& /^https:\/\/(?:app\.)?totemstudio\.ai\//u.test(address)) }, ['title', 'url']), 50),
	}, ['service_id', 'name', 'when_to_use', 'meeting_type', 'duration_minutes', 'min_notice_minutes', 'horizon_days', 'options', 'booking_pages']);
}

/** Validate actual public discriminators and bounded records; project known envelopes for tools. */
export function projectBusinessResponse(operation: string, value: IDataObject, selectedId?: string): IDataObject | undefined {
	const data = value as Record<string, unknown>;
	const list = (field: string, maximum: number, check: (value: unknown) => boolean = record) => {
		const rows = data[field]; return Array.isArray(rows) && rows.length <= maximum && rows.every(check);
	};
	switch (operation) {
		case 'call.analysis.update': case 'meeting.analysis.update': return data.object === 'analysis_receipt'
			&& data.resource_kind === (operation === 'call.analysis.update' ? 'call' : 'meeting') && boolean(data.summary_updated)
			&& boolean(data.custom_values_updated) && one('not_requested', 'applied', 'deferred', 'unavailable')(data.finite_status)
			&& (operation !== 'meeting.analysis.update' || data.custom_values_updated === false)
			? copy(data, ['object', 'resource_kind', 'summary_updated', 'custom_values_updated', 'finite_status']) : undefined;
		case 'booking_services.options':
			if (data.object !== 'booking_service_options' || !string(128, 1)(data.timezone) || !boolean(data.complete)
				|| !nullable(content)(data.next_cursor) || !list('data', 50, calendarServiceOption)) return undefined;
			return { ...copy(data, ['object', 'timezone', 'complete', 'next_cursor']),
				data: (data.data as Record<string, unknown>[]).map(service => ({ ...copy(service, ['service_id', 'name', 'when_to_use', 'meeting_type', 'duration_minutes', 'min_notice_minutes', 'horizon_days']),
					options: (service.options as Record<string, unknown>[]).map(option => ({ ...copy(option, ['label', 'duration_minutes', 'when_to_use']), payment: copy(option.payment as Record<string, unknown>, ['mode', 'amount_minor', 'currency', 'basis']) })),
					booking_pages: (service.booking_pages as Record<string, unknown>[]).map(page => copy(page, ['title', 'url'])),
				})) };
		case 'assistants.options': return data.object === 'assistant_options' && boolean(data.complete) && list('data', 50, row => record(row)
			&& reference('tast1')(row.reference) && string(200, 1)(row.name) && integer(1)(row.version))
			? { object: 'assistant_options', data: (data.data as Record<string, unknown>[]).map(row => copy(row, ['reference', 'name', 'version'])), complete: data.complete } : undefined;
		case 'leads.scheduleContact':
			if (data.object !== 'scheduled_contact_receipt' || !record(data.lead) || data.lead.object !== 'lead_source_receipt' || !lead(data.lead.id)
				|| !sourceEtag('lrs1')(data.lead.etag) || !instant(data.lead.updated_at) || !instant(data.contact_at) || !one('call', 'whatsapp')(data.channel) || !boolean(data.created)) return undefined;
			return { ...copy(data, ['object', 'contact_at', 'channel', 'created']), lead: copy(data.lead, ['object', 'id', 'etag', 'updated_at']) };
		case 'leads.handoff': return data.object === 'family_handoff_receipt' && one('accepted', 'needs_review')(data.status) && string(128)(data.office)
			&& boolean(data.moved_source) && boolean(data.notification_queued) ? copy(data, ['object', 'status', 'office', 'moved_source', 'notification_queued']) : undefined;
		case 'referrals.create': return data.object === 'referral_receipt' && data.status === 'received' ? { object: 'referral_receipt', status: 'received' } : undefined;
		case 'calls.options': return data.object === 'call_binding_options' && boolean(data.complete) && list('data', 100, row => record(row)
			&& row.object === 'call_binding' && reference('tcall1')(row.reference) && string(300, 1)(row.assistant_name) && string(300, 1)(row.line_label)
			&& string(64, 1)(row.line_number) && one('phone', 'whatsapp')(row.channel))
			? { object: 'call_binding_options', data: (data.data as Record<string, unknown>[]).map(row => copy(row, ['object', 'reference', 'assistant_name', 'line_label', 'line_number', 'channel'])), complete: data.complete } : undefined;
		case 'calls.transcript': return data.object === 'call_transcript' && data.call_id === selectedId && opaque('call')(data.call_id) && string(200_000)(data.text) && boolean(data.complete)
			? copy(data, ['object', 'call_id', 'text', 'complete']) : undefined;
		case 'calls.recording': return data.object === 'call_recording' && data.call_id === selectedId && opaque('call')(data.call_id) && validRecordingUrl(data.url)
			&& instant(data.expires_at) && nullable(string(255, 1))(data.content_type) && nullable(integer(0))(data.size) ? copy(data, ['object', 'call_id', 'url', 'expires_at', 'content_type', 'size']) : undefined;
		case 'crm.context':
			if (data.object !== 'crm_context' || !record(data.team) || !opaque('team')(data.team.id) || !(data.lead === null || record(data.lead)
				&& data.lead.object === 'lead_source' && lead(data.lead.id) && sourceEtag('lrs1')(data.lead.etag)) || !record(data.coverage)
				|| !shape(data.source_contact, { phone: nullable(string(80, 1)) }, ['phone'])
				|| data.family_routing !== undefined && !familyRouting(data.family_routing)) return undefined;
			return copy(data, ['object', 'conversation_id', 'call_id', 'source_contact', 'lead', 'team', 'notes', 'notes_has_more', 'custom_values', 'automation', 'pipeline', 'runtime', 'family_routing', 'messages', 'calls', 'payments', 'coverage', 'model_context']);
		case 'messages.channels':
			if (data.object !== 'message_channels' || !list('channels', 100, row => record(row) && typeof row.reference === 'string'
				&& /^mch1_[a-f0-9]{64}$/u.test(row.reference) && one('whatsapp', 'facebook', 'instagram', 'tiktok', 'email', 'sms', 'chatbot')(row.channel_type) && string(300, 1)(row.name))) return undefined;
			return { object: 'message_channels', channels: (data.channels as Record<string, unknown>[]).map(row => copy(row, ['reference', 'channel_type', 'name'])) };
		case 'conversations.messages':
			if (data.object !== 'conversation_messages' || typeof data.truncated !== 'boolean' || !list('messages', 50, row => record(row)
				&& string(69, 69)(row.reference) && /^mmb1_[a-f0-9]{64}$/u.test(row.reference) && one('inbound', 'outbound')(row.direction) && instant(row.at)
				&& one('text', 'image', 'audio', 'video', 'file', 'unknown')(row.content_type) && string(8_000)(row.text)
				&& boolean(row.text_truncated) && boolean(row.has_attachment) && nullable(one('delivered', 'read', 'failed'))(row.delivery_status) && boolean(row.imported))) return undefined;
			return { object: 'conversation_messages', messages: (data.messages as Record<string, unknown>[]).map(row => copy(row, ['reference', 'direction', 'at', 'content_type', 'text', 'text_truncated', 'has_attachment', 'delivery_status', 'imported'])), truncated: data.truncated };
		case 'bookings.availability':
			if (data.object !== 'booking_availability' || !opaque('svc')(data.service_id) || !string(100, 1)(data.timezone) || !instant(data.expires_at)
				|| !list('options', 50, row => record(row) && calendar(row.id) && string(300, 1)(row.label) && integer(1, 1_440)(row.duration_minutes))
				|| !list('slots', 20, row => record(row) && calendar(row.offer) && instant(row.starts_at) && instant(row.ends_at))) return undefined;
			return copy(data, ['object', 'service_id', 'timezone', 'expires_at', 'options', 'slots']);
		case 'bookings.inspect': return data.object === 'booking_management' && data.id === selectedId && validBookingActionEtag(data.etag) ? value : undefined;
		case 'bookings.forLead': return data.object === 'booking_management_list' && boolean(data.complete)
			&& list('data', 20, row => record(row) && row.object === 'booking_management' && opaque('bkg')(row.id) && validBookingActionEtag(row.etag)) ? copy(data, ['object', 'data', 'complete']) : undefined;
		case 'bookingPayments.get': return data.object === 'booking_payment_list' && boolean(data.complete)
			&& list('payments', 5, row => record(row) && row.object === 'booking_payment' && calendar(row.reference) && integer(0)(row.amount_minor)
				&& typeof row.currency === 'string' && /^[A-Z]{3}$/u.test(row.currency) && typeof row.status === 'string') ? copy(data, ['object', 'payments', 'complete']) : undefined;
		case 'library.list': return data.object === 'library_entry_list' && list('data', 50, validEntry)
			&& nullable(content)(data.next_cursor) && one('page', 'complete')(data.coverage) && nullable(integer(0))(data.total) && integer(0)(data.matched_in_page)
			? copy(data, ['object', 'data', 'next_cursor', 'coverage', 'total', 'matched_in_page']) : undefined;
		case 'library.get': return validEntry(data) ? value : undefined;
		case 'library.prepared': {
			const prepared = projectPreparedVisitorDescriptor(data); return prepared as unknown as IDataObject | undefined;
		}
		case 'attachments.resolve': return data.object === 'attachment' && validPreparedAttachmentUrl(data.url) && string(200, 1)(data.mime_type)
			&& nullable(string(2_000))(data.file_name) && nullable(integer(0))(data.file_size) ? copy(data, ['object', 'url', 'mime_type', 'file_name', 'file_size']) : undefined;
		case 'catalog.search': return data.object === 'catalog_result_list' && boolean(data.complete) && list('data', 100, row => record(row)
			&& content(row.catalog) && content(row.variant) && content(row.product) && integer(0)(row.revision) && string(2_000)(row.title)
			&& record(row.price) && record(row.booking)) ? copy(data, ['object', 'data', 'complete']) : undefined;
		default: return undefined;
	}
}
function validRecordingUrl(value: unknown): boolean {
	if (!string(8_192, 1)(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
			&& (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/totem-402908-eu/teams/')
				|| url.hostname === 'totem-402908-eu.storage.googleapis.com' && url.pathname.startsWith('/teams/'));
	} catch { return false; }
}
function validEntry(value: unknown): boolean {
	return record(value) && value.object === 'library_entry' && content(value.reference) && string(2_000)(value.name)
		&& string(20_000)(value.description) && one('message', 'media', 'sequence')(value.type) && integer(0)(value.revision)
		&& integer(0)(value.part_count) && integer(0)(value.file_count) && string(1_200)(value.preview)
		&& nullable(string(100))(value.language) && (value.parts === undefined || array(record, 25)(value.parts));
}

const CLOSED_ENDPOINTS = ['tasks.create', 'tasks.complete', 'notifications.create', 'bookings.create', 'bookings.cancel', 'bookings.reschedule',
	'assistants.run', 'quotes.recordOutcome', 'calls.start', 'bookingPayments.sendLink', 'messages.send', 'messages.prepareReply', 'messages.requestInfo', 'library.send', 'catalog.send'];
export function projectOperationResponse(value: IDataObject): IDataObject | undefined {
	const fields = ['object', 'id', 'status', 'endpoint', 'created_at', 'updated_at', 'result', 'error'];
	if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
		|| value.object !== 'operation' || !opaque('op')(value.id) || !one('queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')(value.status)
		|| typeof value.endpoint !== 'string' || !CLOSED_ENDPOINTS.includes(value.endpoint) || !instant(value.created_at) || !instant(value.updated_at)) return undefined;
	let result: IDataObject | null = null;
	if (value.result !== null) {
		if (!record(value.result)) return undefined;
		const row = value.result;
		if (value.endpoint === 'notifications.create' || value.endpoint === 'tasks.create' || value.endpoint === 'tasks.complete') {
			const notification = value.endpoint === 'notifications.create';
			if (!shape(row, { object: literal(notification ? 'notification_receipt' : 'task_receipt'), id: opaque(notification ? 'ntf' : 'task'),
				status: notification ? one('new', 'archived') : one('open', 'done'),
				...(notification ? { handoff: (field: unknown) => shape(field, { reason: literal('missed_team_appointment'), incident: one('pending_human', 'resolved', 'lead_missing') }, ['reason', 'incident']) } : {}) }, ['object', 'id', 'status'])) return undefined;
			result = copy(row, ['object', 'id', 'status']);
			if (notification && record(row.handoff)) result.handoff = copy(row.handoff, ['reason', 'incident']);
		} else if (['bookings.create', 'bookings.cancel', 'bookings.reschedule', 'bookingPayments.sendLink'].includes(String(value.endpoint))) {
			if (row.object === 'booking_payment_receipt') {
				if (!['bookings.create', 'bookingPayments.sendLink'].includes(String(value.endpoint)) || !shape(row, { object: literal('booking_payment_receipt'), reference: calendar,
					outcome: one('payment_required', 'payment_processing', 'payment_review', 'link_sent'), booking_confirmed: literal(false) }, ['object', 'reference', 'outcome', 'booking_confirmed'])) return undefined;
				result = copy(row, ['object', 'reference', 'outcome', 'booking_confirmed']);
			} else {
				if (value.endpoint === 'bookingPayments.sendLink' || !shape(row, { object: literal('booking_receipt'), id: opaque('bkg'),
					status: one('scheduled', 'cancelled', 'rescheduled', 'unchanged'), previous_id: nullable(opaque('bkg')) }, ['object', 'id', 'status', 'previous_id'])) return undefined;
				result = copy(row, ['object', 'id', 'status', 'previous_id']);
			}
		} else if (value.endpoint === 'quotes.recordOutcome') {
			if (!shape(row, { object: literal('quote_outcome_receipt'), status: literal('recorded'), delivery_evidence: literal('caller_attested') }, ['object', 'status', 'delivery_evidence'])) return undefined;
			result = copy(row, ['object', 'status', 'delivery_evidence']);
		} else if (value.endpoint === 'assistants.run') {
			if (!shape(row, { object: literal('assistant_run_receipt'), status: literal('completed'), conversation_id: conversation }, ['object', 'status', 'conversation_id'])) return undefined;
			result = copy(row, ['object', 'status', 'conversation_id']);
		} else if (value.endpoint === 'calls.start') {
			if (!shape(row, { object: literal('call_start_receipt'), status: literal('accepted'), call_id: nullable(opaque('call')) }, ['object', 'status', 'call_id'])) return undefined;
			result = copy(row, ['object', 'status', 'call_id']);
		} else if (value.endpoint === 'messages.prepareReply') {
			const texts = array(string(4_000), 20);
			if (!shape(row, { object: literal('first_reply_receipt'), skip_ai_reply: boolean, prepared_reference: nullable(content),
				first_reply: nullable(first => shape(first, { capability: literal('first_reply_v1'), status: string(40, 1), reason: string(100), language: string(10),
					sent_content: texts, prepared_content: texts, last_delivered_question: string(1_000) }, ['capability', 'status', 'sent_content'])) },
			['object', 'skip_ai_reply', 'prepared_reference', 'first_reply'])) return undefined;
			result = { ...copy(row, ['object', 'skip_ai_reply', 'prepared_reference']), first_reply: row.first_reply === null ? null
				: copy(row.first_reply as Record<string, unknown>, ['capability', 'status', 'reason', 'language', 'sent_content', 'prepared_content', 'last_delivered_question']) };
		} else if (value.endpoint === 'messages.requestInfo') {
			if (!shape(row, { object: literal('requested_info_receipt'), status: one('queued', 'already_queued'), channel: one('whatsapp', 'email'),
				delivery_confirmed: literal(false), includes_requested_detail: boolean, eta_minutes: field => field === 5 },
			['object', 'status', 'channel', 'delivery_confirmed', 'includes_requested_detail', 'eta_minutes'])) return undefined;
			result = copy(row, ['object', 'status', 'channel', 'delivery_confirmed', 'includes_requested_detail', 'eta_minutes']);
		} else if (value.endpoint === 'messages.send' && row.object === 'message_receipt') {
			if (!shape(row, { object: literal('message_receipt'), status: one('sent', 'prepared'), conversation_id: conversation }, ['object', 'status', 'conversation_id'])) return undefined;
			result = copy(row, ['object', 'status', 'conversation_id']);
		} else if (value.endpoint === 'library.send' || value.endpoint === 'messages.send') {
			if (!shape(row, { object: literal('library_delivery_receipt'), status: one('sent', 'partial', 'uncertain', 'failed', 'held', 'in_progress', 'prepared'), sent_parts: integer(0),
				total_parts: integer(0), prepared: boolean, prepared_reference: nullable(content),
				reason: one('none', 'already_sent', 'resource_changed', 'conversation_changed', 'session_closed', 'delivery_refused', 'provider_outcome_unknown', 'content_erased', 'not_prepared') },
			['object', 'status', 'sent_parts', 'total_parts', 'prepared', 'prepared_reference', 'reason']) || Number(row.sent_parts) > Number(row.total_parts)
				|| row.prepared === true && (row.status !== 'prepared' || row.prepared_reference === null)) return undefined;
			result = copy(row, ['object', 'status', 'sent_parts', 'total_parts', 'prepared', 'prepared_reference', 'reason']);
		} else if (value.endpoint === 'catalog.send') {
			if (!shape(row, { object: literal('catalog_send_receipt'), sent_as: one('catalog_product', 'catalog_product_list'), variant_count: integer(1, 30) }, ['object', 'sent_as', 'variant_count'])) return undefined;
			result = copy(row, ['object', 'sent_as', 'variant_count']);
		} else return undefined;
	}
	if (value.error !== null && !shape(value.error, { code: one('authorization_failed', 'configuration_missing', 'input_expired', 'invalid_input', 'resource_missing', 'execution_failed', 'outcome_unknown') }, ['code'])) return undefined;
	if (result !== null && value.error !== null || ['queued', 'running', 'cancelled'].includes(String(value.status)) && (result !== null || value.error !== null)
		|| ['failed', 'outcome_unknown'].includes(String(value.status)) && (result !== null || value.error === null)
		|| value.status === 'succeeded' && value.error !== null) return undefined;
	return { ...copy(value, fields), result };
}
