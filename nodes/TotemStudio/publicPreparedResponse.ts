/** One visitor envelope projection over authorized prepared/attachment API responses. No persistence or raw path lookup. */
export interface PublicVisitorMedia { url: string; mimeType: string; fileName?: string; fileSize?: number }
export interface PublicVisitorMessage {
	id: string;
	role: 'assistant';
	kind: 'text' | 'image' | 'video' | 'audio' | 'document';
	content?: string;
	timestamp: string;
	media?: PublicVisitorMedia;
}
export interface PublicVisitorResponse { version: 1; messages: PublicVisitorMessage[] }
export class PreparedVisitorResponseError extends Error {
	constructor() { super('The prepared visitor response no longer matches its authorized content.'); this.name = 'PreparedVisitorResponseError'; }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const reference = (value: unknown): value is string => bounded(value, 16_384) && value.length >= 40 && /^tcnt1\.[A-Za-z0-9_-]+$/u.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullable = (value: unknown, maximum: number) => value === null || bounded(value, maximum, true);
function instant(value: unknown): value is string {
	if (!bounded(value, 40) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) return false;
	return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function validPreparedAttachmentUrl(value: unknown): value is string {
	if (!bounded(value, 8_192)) return false;
	try {
		const url = new URL(value);
		const google = '/totem-402908-eu/';
		const firebase = '/v0/b/totem-402908-eu/o/';
		return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
			&& (url.hostname === 'storage.googleapis.com' && !url.search && url.pathname.startsWith(google) && url.pathname.length > google.length
				|| url.hostname === 'firebasestorage.googleapis.com' && url.pathname.startsWith(firebase) && url.pathname.length > firebase.length
					&& [...url.searchParams.keys()].every(key => ['alt', 'token'].includes(key)) && url.searchParams.getAll('alt').length === 1
					&& url.searchParams.get('alt') === 'media' && url.searchParams.getAll('token').length <= 1);
	} catch { return false; }
}
const fail = (): never => { throw new PreparedVisitorResponseError(); };

export interface PublicPreparedMedia { attachment_reference: string; mime_type: string; file_name: string | null; file_size: number | null }
export interface PublicPreparedDescriptor { object: 'library_prepared_response'; version: 1; messages: Array<Omit<PublicVisitorMessage, 'media'> & { media?: PublicPreparedMedia }> }
/** Validate and project the opaque descriptor without resolving or disclosing file locations. */
export function projectPreparedVisitorDescriptor(value: unknown): PublicPreparedDescriptor | undefined {
	if (!record(value) || value.object !== 'library_prepared_response' || value.version !== 1 || !Array.isArray(value.messages) || value.messages.length > 25) return undefined;
	const ids = new Set<string>();
	const messages: PublicPreparedDescriptor['messages'] = [];
	for (const row of value.messages) {
		if (!record(row) || !bounded(row.id, 300) || ids.has(row.id) || row.role !== 'assistant'
			|| !['text', 'image', 'video', 'audio', 'document'].includes(String(row.kind)) || !instant(row.timestamp)
			|| row.content !== undefined && !bounded(row.content, 100_000, true)) return undefined;
		ids.add(row.id);
		let media: PublicPreparedMedia | undefined;
		if (row.kind === 'text') { if (row.media !== undefined) return undefined; }
		else {
			const retained = row.media;
			if (!record(retained) || !reference(retained.attachment_reference) || !bounded(retained.mime_type, 200)
				|| !nullable(retained.file_name, 2_000) || !(retained.file_size === null || count(retained.file_size))) return undefined;
			media = { attachment_reference: retained.attachment_reference, mime_type: retained.mime_type,
				file_name: retained.file_name as string | null, file_size: retained.file_size as number | null };
		}
		messages.push({ id: row.id, role: 'assistant', kind: row.kind as PublicVisitorMessage['kind'], timestamp: row.timestamp,
			...(typeof row.content === 'string' ? { content: row.content } : {}), ...(media ? { media } : {}) });
	}
	return { object: 'library_prepared_response', version: 1, messages };
}

/** Resolve only actual media references; an incomplete permission check never returns a partial URL-bearing envelope. */
export async function formatPreparedVisitorResponse(prepared: unknown,
	resolveAttachment: (reference: string) => Promise<unknown>): Promise<PublicVisitorResponse> {
	const descriptor = projectPreparedVisitorDescriptor(prepared);
	if (!descriptor) return fail();
	const cache = new Map<string, Promise<unknown>>();
	const messages: PublicVisitorMessage[] = [];
	for (const row of descriptor.messages) {
		const message: PublicVisitorMessage = { id: row.id, role: 'assistant', kind: row.kind,
			...(row.content ? { content: row.content } : {}), timestamp: row.timestamp };
		if (row.media) {
			const media = row.media;
			let promise = cache.get(media.attachment_reference);
			if (!promise) {
				promise = resolveAttachment(media.attachment_reference);
				cache.set(media.attachment_reference, promise);
			}
			const resolved = await promise;
			if (!record(resolved) || resolved.object !== 'attachment' || !validPreparedAttachmentUrl(resolved.url)
				|| !bounded(resolved.mime_type, 200) || resolved.mime_type !== media.mime_type
				|| !nullable(resolved.file_name, 2_000) || !(resolved.file_size === null || count(resolved.file_size))
				|| media.file_name !== null && resolved.file_name !== null && media.file_name !== resolved.file_name
				|| media.file_size !== null && resolved.file_size !== null && media.file_size !== resolved.file_size) return fail();
			const fileName = media.file_name ?? resolved.file_name;
			const fileSize = media.file_size ?? resolved.file_size;
			message.media = { url: resolved.url, mimeType: resolved.mime_type,
				...(typeof fileName === 'string' ? { fileName } : {}), ...(typeof fileSize === 'number' ? { fileSize } : {}) };
		}
		messages.push(message);
	}
	return { version: 1, messages };
}

/** The read ports remain bound to the original API credential, selected team and executed signed context. */
export async function resolvePreparedVisitorResponse(receipt: unknown, readers: {
	prepared(reference: string): Promise<unknown>;
	attachment(reference: string): Promise<unknown>;
}): Promise<PublicVisitorResponse | undefined> {
	if (!record(receipt)) return undefined;
	if (receipt.object === 'first_reply_receipt') {
		if (receipt.prepared_reference === null) return undefined;
		if (!reference(receipt.prepared_reference)) return fail();
		return formatPreparedVisitorResponse(await readers.prepared(receipt.prepared_reference), readers.attachment);
	}
	if (receipt.object !== 'library_delivery_receipt') return undefined;
	if (receipt.status !== 'prepared' && receipt.prepared !== true) return undefined;
	if (receipt.status !== 'prepared' || receipt.prepared !== true || !reference(receipt.prepared_reference)) return fail();
	return formatPreparedVisitorResponse(await readers.prepared(receipt.prepared_reference), readers.attachment);
}
