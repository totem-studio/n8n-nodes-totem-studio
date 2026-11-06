import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { INHERIT_TOTEM_EXECUTION_CONTEXT, totemExecutionAnalysisParents, totemExecutionIngressParents, totemExecutionSourceParents } from './runtimeExecutionContext';
import { TotemStudioV2ClientError, validPublicId, type TotemStudioV2Identity } from './totemStudioV2Client';

/** Request-local proof, never placed in credentials, identity or workflow context caches. */
export interface PublicApiExecutionAuthority {
	token: string;
	principalId: string;
	rawTeamId: string;
	apiTeamId: string;
	/** Stable original server-owned dispatch/action identity, never the n8n execution id. */
	executionId: string;
	/** Only a redeemed server context from the executed private auxiliary source. */
	auxiliaryExecutionRef?: PublicApiAuxiliaryReference & { childExecutionId: string };
}

/** Closed wire metadata. Parsing this reference does not verify its MAC or current server authority. */
export interface PublicApiAuxiliaryReference {
	version: 1;
	sourceAnchor: string;
	invocationId: string;
	originNodeId: string;
	bindingId: string;
	bindingGeneration: string;
	reviewGeneration: string;
	parentWorkflowId: string;
	parentExecutionId: string;
	childWorkflowId: string;
	childExecutionId: string | null;
}

const cleanId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
	&& value.length <= 512 && value.trim() === value && !value.includes('/')
	&& [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const auxiliaryId = (value: unknown): value is string => cleanId(value) && value !== '.' && value !== '..' && value.toLowerCase() !== 'unknown';
const auxiliaryFields = ['version', 'sourceAnchor', 'invocationId', 'originNodeId', 'bindingId', 'bindingGeneration',
	'reviewGeneration', 'parentWorkflowId', 'parentExecutionId', 'childWorkflowId', 'childExecutionId'];

/** Format only. HMAC and current source/grant verification remain server-owned. */
export function readPublicApiExecutionClaims(token: unknown): Record<string, unknown> | null {
	if (typeof token !== 'string' || token.length > 24_000 || !/^(?:taw2|tsa2)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) return null;
	try {
		const encoded = token.split('.')[1]!, bytes = Buffer.from(encoded, 'base64url');
		if (bytes.toString('base64url') !== encoded) return null;
		const claims: unknown = JSON.parse(bytes.toString('utf8'));
		return record(claims) ? claims : null;
	} catch { return null; }
}

/** Existing server envelope only. Empty V1 remains byte-compatible; presented V2 must match its authenticated typed resource. */
export function readPublicApiSystemAnalysisIngress(body: unknown, input: {
	authenticated: boolean; teamId: unknown; resourceId: unknown; kind: 'call' | 'meeting';
}): { automationWriteContext?: string; apiTeamId?: string; analysisResourceId?: string } | null {
	if (!record(body)) return null;
	if (!['publicApiWriteContext', 'apiTeamId', 'analysisResourceId'].some(key => Object.prototype.hasOwnProperty.call(body, key))) return {};
	const token = body.publicApiWriteContext, claims = readPublicApiExecutionClaims(token);
	const action = input.kind === 'call' ? 'call.analysis.update' : 'meeting.analysis.update';
	if (!input.authenticated || typeof token !== 'string' || !token.startsWith('tsa2.') || !claims
		|| claims.version !== 2 || claims.kind !== 'system_analysis' || claims.actor !== 'totem-system-analyzer'
		|| !cleanId(input.teamId) || claims.teamId !== input.teamId || !cleanId(claims.principalId)
		|| claims.resourceKind !== input.kind || !cleanId(input.resourceId) || claims.resourceId !== input.resourceId
		|| claims.action !== action || !Array.isArray(claims.allowedOperations)
		|| claims.allowedOperations.length !== 1 || claims.allowedOperations[0] !== action
		|| !cleanId(claims.executionId) || claims.executionId !== claims.dispatchGeneration
		|| !validPublicId(body.apiTeamId, 'team') || !validPublicId(body.analysisResourceId, input.kind === 'call' ? 'call' : 'bkg')) return null;
	return { automationWriteContext: token, apiTeamId: body.apiTeamId, analysisResourceId: body.analysisResourceId };
}

/** A genuine direct Native tool already carries its server-issued action proof; never synthesize a chat/child reference for it. */
export function inheritedNativeAuxiliaryContext(context: IExecuteFunctions, itemIndex: number): {
	token: string; teamId: string; apiTeamId: string;
} | null {
	if (context.getMode() === 'manual') return null;
	const values: Array<{ token: string; teamId: string; apiTeamId: string }> = [];
	for (const candidate of totemExecutionIngressParents(context).filter(node =>
		['CUSTOM.totemStudioToolTrigger', 'n8n-nodes-totem-studio.totemStudioToolTrigger'].includes(node.type))) {
		const selected = `$(${JSON.stringify(candidate.name)})`;
		const evidence: unknown = context.evaluateExpression(`{{ ${selected}.isExecuted ? ({ token: ${selected}.first().json.publicApiWriteContext, teamId: ${selected}.first().json.teamId || ${selected}.first().json.team_id || '', apiTeamId: ${selected}.first().json.apiTeamId }) : null }}`, itemIndex);
		if (evidence === null) continue;
		if (!record(evidence) || typeof evidence.token !== 'string' || !cleanId(evidence.teamId)
			|| !validPublicId(evidence.apiTeamId, 'team')) return null;
		const claims = readPublicApiExecutionClaims(evidence.token), configured = candidate.parameters?.teamId;
		if (!evidence.token.startsWith('taw2.') || !claims || claims.version !== 2 || claims.kind !== 'assistant' || claims.executionPath !== 'public'
			|| !record(claims.executionRef) || !['browser_voice', 'native_phone', 'retell_call'].includes(String(claims.executionRef.kind))
			|| claims.auxiliaryExecutionRef !== undefined || claims.teamId !== evidence.teamId || !cleanId(claims.executionId)
			|| typeof configured === 'string' && !configured.startsWith('=') && configured.trim() && configured.trim() !== evidence.teamId) return null;
		values.push({ token: evidence.token, teamId: evidence.teamId, apiTeamId: evidence.apiTeamId });
	}
	return values.length === 1 ? values[0]! : null;
}

export function readPublicApiAuxiliaryReference(value: unknown, teamId: string): PublicApiAuxiliaryReference | null {
	if (!record(value) || Object.keys(value).length !== auxiliaryFields.length
		|| Object.keys(value).some(key => !auxiliaryFields.includes(key)) || value.version !== 1
		|| typeof value.sourceAnchor !== 'string'
		|| typeof value.bindingGeneration !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bindingGeneration)
		|| typeof value.reviewGeneration !== 'string' || !/^[a-f0-9]{64}$/u.test(value.reviewGeneration)
		|| !['invocationId', 'originNodeId', 'bindingId', 'parentWorkflowId', 'parentExecutionId', 'childWorkflowId'].every(key => auxiliaryId(value[key]))
		|| value.childExecutionId !== null && !auxiliaryId(value.childExecutionId)) return null;
	const anchor = value.sourceAnchor.split('/');
	if (anchor.length !== 4 || anchor[0] !== 'teams' || anchor[1] !== teamId || !auxiliaryId(anchor[1])
		|| anchor[2] !== 'usageEvents' || !auxiliaryId(anchor[3])) return null;
	return { version: 1, sourceAnchor: value.sourceAnchor, invocationId: String(value.invocationId),
		originNodeId: String(value.originNodeId), bindingId: String(value.bindingId), bindingGeneration: value.bindingGeneration,
		reviewGeneration: value.reviewGeneration, parentWorkflowId: String(value.parentWorkflowId),
		parentExecutionId: String(value.parentExecutionId), childWorkflowId: String(value.childWorkflowId),
		childExecutionId: value.childExecutionId === null ? null : String(value.childExecutionId) };
}

/** Format and envelope binding only. The API alone verifies HMAC, current grants and the domain execution. */
export function resolvePublicApiExecutionContext(context: IExecuteFunctions, itemIndex: number, rawContext: unknown,
	identity: TotemStudioV2Identity, selectedApiTeamId: string | undefined): PublicApiExecutionAuthority | undefined {
	if (identity.principalKind !== 'automation_service') {
		if (rawContext !== INHERIT_TOTEM_EXECUTION_CONTEXT) throw new TotemStudioV2ClientError('invalid_request', 400);
		return undefined;
	}
	if (context.getMode() === 'manual' || rawContext === '' || rawContext === null || rawContext === undefined)
		throw new TotemStudioV2ClientError('invalid_credentials', 401);
	try {
		const executed: Array<{ value: Record<string, unknown>; configuredTeam: unknown; auxiliarySource: boolean; analysisKind?: 'call' | 'meeting' }> = [];
		const sourceParents = totemExecutionSourceParents(context);
		const analysisParents = totemExecutionAnalysisParents(context);
		for (const candidate of sourceParents.length ? sourceParents : [...totemExecutionIngressParents(context), ...analysisParents]) {
			const selected = `$(${JSON.stringify(candidate.name)})`;
			const analysisKind = analysisParents.includes(candidate) ? candidate.type.endsWith('MeetingTrigger') ? 'meeting' : 'call' : undefined;
			const analysis = analysisKind ? `, analysisResourceId: ${selected}.first().json.analysisResourceId, resourceId: ${selected}.first().json.${analysisKind === 'meeting' ? 'appointment_id' : candidate.type.endsWith('ZadarmaTrigger') ? 'pbx_call_id' : 'call_id'}` : '';
			const evidence = context.evaluateExpression(`{{ ${selected}.isExecuted ? ({ token: ${selected}.first().json.automationWriteContext, teamId: ${selected}.first().json.teamId || ${selected}.first().json.team_id || '', apiTeamId: ${selected}.first().json.apiTeamId${analysis} }) : null }}`, itemIndex);
			if (evidence === null) continue;
			if (!record(evidence)) throw new Error('invalid ingress');
			executed.push({ value: evidence, configuredTeam: candidate.parameters?.teamId,
				auxiliarySource: candidate.type === 'CUSTOM.totemStudioAuxiliarySource', ...(analysisKind ? { analysisKind } : {}) });
		}
		if (executed.length !== 1) throw new Error('one executed ingress required');
		const { value, configuredTeam, auxiliarySource, analysisKind } = executed[0]!;
		const token = value.token;
		if (typeof token !== 'string' || token.length > 24_000
			|| !/^(?:taw2|tsa2)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)
			|| rawContext !== INHERIT_TOTEM_EXECUTION_CONTEXT && rawContext !== token
			|| !cleanId(value.teamId) || !validPublicId(value.apiTeamId, 'team')
			|| selectedApiTeamId !== undefined && selectedApiTeamId !== value.apiTeamId) throw new Error('invalid execution envelope');
		const claims = readPublicApiExecutionClaims(token);
		if (!claims || claims.version !== 2 || !['assistant', 'job', 'system_analysis'].includes(String(claims.kind))
			|| token.startsWith('tsa2.') !== (claims.kind === 'system_analysis')
			|| claims.principalId !== identity.connection.id || claims.teamId !== value.teamId
			|| !cleanId(claims.executionId)
			|| typeof configuredTeam === 'string' && !configuredTeam.startsWith('=') && configuredTeam.trim()
				&& configuredTeam.trim() !== value.teamId) throw new Error('execution identity mismatch');
		if ((claims.kind === 'system_analysis') !== (analysisKind !== undefined)) throw new Error('analysis ingress mismatch');
		if (analysisKind) {
			const projection = readPublicApiSystemAnalysisIngress({ publicApiWriteContext: token, apiTeamId: value.apiTeamId,
				analysisResourceId: value.analysisResourceId }, { authenticated: true, teamId: value.teamId, resourceId: value.resourceId, kind: analysisKind });
			const resource = context.getNodeParameter('resource', itemIndex, '');
			const prefix = typeof resource === 'string' && resource.startsWith('api_') ? 'public' : '';
			if (!projection || projection.automationWriteContext !== token
				|| resource !== `${prefix ? 'api_' : ''}${analysisKind === 'call' ? 'call' : 'booking'}`
				|| context.getNodeParameter(prefix ? 'publicOperation' : 'operation', itemIndex, '') !== 'updateAnalysis'
				|| context.getNodeParameter(prefix ? 'publicRecordId' : 'recordId', itemIndex, '') !== value.analysisResourceId) throw new Error('analysis resource mismatch');
		}
		let auxiliaryExecutionRef: PublicApiExecutionAuthority['auxiliaryExecutionRef'];
		if (claims.auxiliaryExecutionRef !== undefined) {
			const ref = readPublicApiAuxiliaryReference(claims.auxiliaryExecutionRef, value.teamId);
			if (!auxiliarySource || claims.kind !== 'assistant' || !ref || ref.childExecutionId === null
				|| context.getWorkflow().id !== ref.childWorkflowId || context.getExecutionId() !== ref.childExecutionId
				|| context.getExecutionContext()?.parentExecutionId !== ref.parentExecutionId) throw new Error('auxiliary execution mismatch');
			auxiliaryExecutionRef = { ...ref, childExecutionId: ref.childExecutionId };
		} else if (auxiliarySource) {
			const native = inheritedNativeAuxiliaryContext(context, itemIndex);
			if (!native || native.token !== token || native.teamId !== value.teamId || native.apiTeamId !== value.apiTeamId)
				throw new Error('auxiliary source has no genuine Native ingress');
		}
		return { token, principalId: String(claims.principalId), rawTeamId: value.teamId, apiTeamId: value.apiTeamId,
			executionId: claims.executionId, ...(auxiliaryExecutionRef ? { auxiliaryExecutionRef } : {}) };
	} catch { throw new NodeOperationError(context.getNode(), new TotemStudioV2ClientError('invalid_credentials', 401)); }
}
