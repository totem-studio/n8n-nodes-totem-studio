/** Pure shared helpers for the public API nodes. No environment, filesystem, ingress or provider credentials. */


export type UnknownRecord = Record<string, unknown>;


export function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}


export function getRecordValue(value: unknown, ...path: string[]): unknown {
	return path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}


// ---------------------------------------------------------------------------
// Error handling — AI-tool self-recovery
// ---------------------------------------------------------------------------

export function getHttpStatusCode(error: unknown): number | undefined {
	const candidates = [
		getRecordValue(error, 'httpCode'),
		getRecordValue(error, 'response', 'status'),
		getRecordValue(error, 'statusCode'),
		getRecordValue(error, 'httpStatusCode'),
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
		if (typeof candidate === 'string' && /^\d{3}$/.test(candidate.trim())) {
			return Number(candidate.trim());
		}
	}
	return undefined;
}


/**
 * Whether an execution error should be swallowed and surfaced as a normal
 * output item rather than thrown.
 *
 * Continues when EITHER:
 *  - the user enabled n8n's native "On Error → Continue" setting
 *    (`continueOnFail()`, on the node's Settings tab in a regular workflow), OR
 *  - the node is running as an AI Agent tool (`isAgentToolExecution()`).
 *
 * The tool case is the important one: n8n hides the Settings/On-Error tab when
 * a node is wired as an Agent tool, so that toggle is unreachable there. Yet
 * returning the error to the model — instead of throwing and aborting the whole
 * agent run — lets the LLM inspect it and choose retry, corrected input, or fallback. Tool
 * executions ALWAYS continue.
 */
export function shouldContinueOnError(ctx: {
	continueOnFail(): boolean;
	isToolExecution?: () => boolean;
	getNode?: () => { rewireOutputLogTo?: string };
}): boolean {
	if (ctx.continueOnFail()) return true;
	return isAgentToolExecution(ctx);
}


/** n8n's `NodeConnectionTypes.AiTool`: the connection of a node an Agent calls. */
export const AI_TOOL_CONNECTION = 'ai_tool';


/**
 * Whether this execution is an AI Agent calling the node as a tool.
 *
 * `isToolExecution()` alone is not enough. It only answers true on the legacy
 * path, where the tool runs inside the Agent's supply-data context. n8n 2.x
 * runs Agent tool calls as engine requests: the tool node executes as an
 * ordinary node whose `ExecuteContext.isToolExecution()` always returns false
 * (n8n 2.37.10, `execute-context.ts`), and the engine marks it instead by
 * setting `node.rewireOutputLogTo = 'ai_tool'` (`requests-response.ts`). Missing
 * that mark made the node throw rather than return a readable tool result
 * (Tu Hipoteca Ideal, execution 71623, 2026-10-04). Both are checked; the
 * method is feature-detected for runtimes that predate it.
 */
export function isAgentToolExecution(ctx: {
	isToolExecution?: () => boolean;
	getNode?: () => { rewireOutputLogTo?: string };
}): boolean {
	if (typeof ctx.isToolExecution === 'function' && ctx.isToolExecution()) return true;
	if (typeof ctx.getNode !== 'function') return false;
	try {
		return ctx.getNode()?.rewireOutputLogTo === AI_TOOL_CONNECTION;
	} catch {
		return false;
	}
}


// ---------------------------------------------------------------------------
// Text sanitization
// ---------------------------------------------------------------------------

/**
 * Coerce a value resolved from an n8n expression to a string. Expressions can
 * resolve to null/undefined, and form/webhook payloads frequently deliver
 * numeric fields (e.g. `phone`) as JS numbers. We coerce primitives to their
 * string form so a numeric phone isn't silently dropped to '' downstream;
 * objects/arrays are intentionally dropped to '' (we never want "[object Object]").
 */
export function str(v: unknown): string {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return '';
}


/** Strip control characters (except newline/tab) and collapse whitespace runs. */
export function cleanText(value: string): string {
	// Deliberately names the C0 controls that are unsafe in compact text.
	// eslint-disable-next-line no-control-regex
	return str(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}


/** Sanitize a string field that is not a person name (identifiers, labels). */
export function cleanString(value: string): string {
	return cleanText(value).replace(/\s+/g, ' ');
}


// ---------------------------------------------------------------------------
// schedule_contact_ai_agent datetime composition
// ---------------------------------------------------------------------------

/**
 * Inputs accepted by composeContactAtMs.
 *
 * Two shapes, in priority order:
 *
 * 1. **Structured fields** (recommended — the "E.164 for datetimes"). All
 *    six fields are integers/strings the LLM can fill independently; the
 *    helper builds the absolute timestamp using the runtime's IANA timezone
 *    database. Nonexistent spring-forward and ambiguous fall-back wall times
 *    are rejected so a follow-up is never silently scheduled at the wrong
 *    instant. This removes the LLM from DST math entirely and is impossible
 *    to break with string-formatting artifacts ('at', day-of-week names,
 *    etc.) because there's no string to mangle.
 *
 * 2. **Legacy ISO string** (`contactWhen`). Kept for backward compatibility
 *    with existing workflows. It must be strict ISO 8601 with an explicit
 *    `Z` or numeric UTC offset, then is bounded to `now - 1h ... now + 60d`.
 *    Natural-language and offset-less values are rejected so the n8n process
 *    timezone cannot silently change the instant.
 *
 * Structured fields win if both are present.
 */
export interface ComposeContactAtInputs {
	year?: number | string | null;
	month?: number | string | null;
	day?: number | string | null;
	hour?: number | string | null;
	minute?: number | string | null;
	timezone?: string | null;
	contactWhen?: string | null;
}


export type ComposeContactAtResult =
	| { ok: true; ms: number; source: 'structured' | 'legacy_string' }
	| { ok: false; error: string };


export const PARSE_LOWER_BOUND_MS = -60 * 60 * 1000;
 // -1 hour from now
export const PARSE_UPPER_BOUND_MS = 60 * 24 * 60 * 60 * 1000;
 // +60 days from now

export function toInt(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v.trim());
		if (Number.isFinite(n)) return Math.trunc(n);
	}
	return null;
}


export function withinBounds(ms: number): boolean {
	const delta = ms - Date.now();
	return delta >= PARSE_LOWER_BOUND_MS && delta <= PARSE_UPPER_BOUND_MS;
}


export interface LocalDateTimeParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}


export function localPartsAt(ms: number, timeZone: string): LocalDateTimeParts | null {
	try {
		const formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
		const parts = Object.fromEntries(
			formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
		);
		const resolved = {
			year: Number(parts.year),
			month: Number(parts.month),
			day: Number(parts.day),
			hour: Number(parts.hour),
			minute: Number(parts.minute),
		};
		return Object.values(resolved).every(Number.isFinite) ? resolved : null;
	} catch {
		return null;
	}
}


export type LocalDateTimeResolution =
	| { kind: 'resolved'; ms: number }
	| { kind: 'invalid-zone' }
	| { kind: 'nonexistent' }
	| { kind: 'ambiguous' };


export function sameLocalParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
	return left.year === right.year
		&& left.month === right.month
		&& left.day === right.day
		&& left.hour === right.hour
		&& left.minute === right.minute;
}


/**
 * Resolve a local wall-clock value using only Intl's IANA database.
 *
 * Sampling both sides of the requested day discovers every applicable UTC
 * offset, including half/quarter-hour zones and a nearby DST transition. Each
 * candidate is then round-tripped through the zone. Zero matches means a gap
 * (or invalid calendar date); two matches means a fall-back fold. Both are
 * rejected instead of guessing which instant the caller intended.
 */
export function localDateTimeToMs(
	target: LocalDateTimeParts,
	timeZone: string,
): LocalDateTimeResolution {
	const targetAsUtc = Date.UTC(
		target.year,
		target.month - 1,
		target.day,
		target.hour,
		target.minute,
	);
	const offsets = new Set<number>();
	for (let hours = -36; hours <= 36; hours += 6) {
		const sampleMs = targetAsUtc + hours * 60 * 60 * 1000;
		const sampleParts = localPartsAt(sampleMs, timeZone);
		if (!sampleParts) return { kind: 'invalid-zone' };
		const sampleAsLocalUtc = Date.UTC(
			sampleParts.year,
			sampleParts.month - 1,
			sampleParts.day,
			sampleParts.hour,
			sampleParts.minute,
		);
		offsets.add(sampleAsLocalUtc - sampleMs);
	}

	const matches = [...offsets]
		.map((offset) => targetAsUtc - offset)
		.filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
		.filter((candidate) => {
			const actual = localPartsAt(candidate, timeZone);
			return actual !== null && sameLocalParts(actual, target);
		})
		.sort((left, right) => left - right);

	if (matches.length === 0) return { kind: 'nonexistent' };
	if (matches.length > 1) return { kind: 'ambiguous' };
	return { kind: 'resolved', ms: matches[0]! };
}


/** Legacy fallback: accept only an ISO 8601 instant with an explicit offset. */
export function parseLegacyContactWhen(input: string): Date | null {
	const trimmed = input.trim();
	const explicitInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
	if (!explicitInstant.test(trimmed)) return null;
	const parsed = new Date(trimmed);
	return isNaN(parsed.getTime()) || !withinBounds(parsed.getTime()) ? null : parsed;
}


/**
 * Compose the millisecond timestamp for schedule_contact_ai_agent from either
 * structured fields (preferred) or a legacy ISO 8601 string.
 *
 * @returns Tagged result. On success, includes which input shape was
 *          used so the caller can log the migration progression.
 */
export function composeContactAtMs(inputs: ComposeContactAtInputs): ComposeContactAtResult {
	// --- Structured-fields path (preferred) ---
	const year = toInt(inputs.year);
	const month = toInt(inputs.month);
	const day = toInt(inputs.day);
	const hour = toInt(inputs.hour);
	const minute = toInt(inputs.minute);
	const tz = typeof inputs.timezone === 'string' ? inputs.timezone.trim() : '';

	const haveStructured =
		year !== null || month !== null || day !== null || hour !== null || minute !== null || tz !== '';

	if (haveStructured) {
		if (year === null || month === null || day === null || hour === null || minute === null) {
			return {
				ok: false,
				error:
					'Structured datetime fields are partially provided. All five required: year, month, day, hour, minute (plus optional timezone, default Europe/Madrid).',
			};
		}
		if (month < 1 || month > 12) return { ok: false, error: `Invalid month: ${month}. Must be 1-12.` };
		if (day < 1 || day > 31) return { ok: false, error: `Invalid day: ${day}. Must be 1-31.` };
		if (hour < 0 || hour > 23) return { ok: false, error: `Invalid hour: ${hour}. Must be 0-23.` };
		if (minute < 0 || minute > 59) return { ok: false, error: `Invalid minute: ${minute}. Must be 0-59.` };
		const zone = tz || 'Europe/Madrid';
		const resolution = localDateTimeToMs({ year, month, day, hour, minute }, zone);
		if (resolution.kind === 'invalid-zone') {
			return {
				ok: false,
				error: `Invalid IANA timezone: ${zone}`,
			};
		}
		if (resolution.kind === 'nonexistent') {
			return {
				ok: false,
				error: `Invalid or nonexistent local datetime: ${year}-${month}-${day} ${hour}:${minute} ${zone}. Choose a real wall-clock time outside the DST spring-forward gap.`,
			};
		}
		if (resolution.kind === 'ambiguous') {
			return {
				ok: false,
				error: `Ambiguous local datetime: ${year}-${month}-${day} ${hour}:${minute} ${zone} occurs twice during the DST fall-back. Choose an unambiguous wall-clock time.`,
			};
		}
		const ms = resolution.ms;
		if (!withinBounds(ms)) {
			return {
				ok: false,
				error: 'Composed datetime is outside the allowed window (must be from now-1h to now+60d).',
			};
		}
		return { ok: true, ms, source: 'structured' };
	}

	// --- Legacy ISO string path ---
	const contactWhen = typeof inputs.contactWhen === 'string' ? inputs.contactWhen : '';
	if (!contactWhen.trim()) {
		return {
			ok: false,
			error:
				'No datetime provided. Pass structured fields (year/month/day/hour/minute/timezone) or contact_when (ISO 8601).',
		};
	}
	const parsed = parseLegacyContactWhen(contactWhen);
	if (!parsed) {
		return {
			ok: false,
			error: `Invalid date: "${contactWhen}". Prefer structured fields {year, month, day, hour, minute, timezone}. If using contact_when (legacy), it must be ISO 8601 like 2026-05-27T16:00:00+02:00 — never include the word "at", day-of-week names, or natural-language phrasing.`,
		};
	}
	return { ok: true, ms: parsed.getTime(), source: 'legacy_string' };
}
