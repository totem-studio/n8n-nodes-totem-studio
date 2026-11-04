import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { INHERIT_TOTEM_EXECUTION_CONTEXT, totemExecutionIngressParents, totemExecutionSourceParents } from './runtimeExecutionContext';
import { TotemStudioV2ClientError, validPublicId, type TotemStudioV2Identity } from './totemStudioV2Client';

/** Request-local proof, never placed in credentials, identity or workflow context caches. */
export interface PublicApiExecutionAuthority {
	token: string;
	principalId: string;
	rawTeamId: string;
	apiTeamId: string;
	/** Stable original server-owned dispatch/action identity, never the n8n execution id. */
	executionId: string;
}

const cleanId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
	&& value.length <= 512 && value.trim() === value && !value.includes('/')
	&& [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

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
		const executed: Array<{ value: Record<string, unknown>; configuredTeam: unknown }> = [];
		const sourceParents = totemExecutionSourceParents(context);
		for (const candidate of sourceParents.length ? sourceParents : totemExecutionIngressParents(context)) {
			const selected = `$(${JSON.stringify(candidate.name)})`;
			const evidence = context.evaluateExpression(`{{ ${selected}.isExecuted ? ({ token: ${selected}.first().json.automationWriteContext, teamId: ${selected}.first().json.teamId || ${selected}.first().json.team_id || '', apiTeamId: ${selected}.first().json.apiTeamId }) : null }}`, itemIndex);
			if (evidence === null) continue;
			if (!record(evidence)) throw new Error('invalid ingress');
			executed.push({ value: evidence, configuredTeam: candidate.parameters?.teamId });
		}
		if (executed.length !== 1) throw new Error('one executed ingress required');
		const { value, configuredTeam } = executed[0]!;
		const token = value.token;
		if (typeof token !== 'string' || token.length > 24_000
			|| !/^(?:taw2|tsa2)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)
			|| rawContext !== INHERIT_TOTEM_EXECUTION_CONTEXT && rawContext !== token
			|| !cleanId(value.teamId) || !validPublicId(value.apiTeamId, 'team')
			|| selectedApiTeamId !== undefined && selectedApiTeamId !== value.apiTeamId) throw new Error('invalid execution envelope');
		const payload = token.split('.')[1]!;
		const bytes = Buffer.from(payload, 'base64url');
		if (bytes.toString('base64url') !== payload) throw new Error('invalid encoding');
		const claims: unknown = JSON.parse(bytes.toString('utf8'));
		if (!record(claims) || claims.version !== 2 || !['assistant', 'job', 'system_analysis'].includes(String(claims.kind))
			|| token.startsWith('tsa2.') !== (claims.kind === 'system_analysis')
			|| claims.principalId !== identity.connection.id || claims.teamId !== value.teamId
			|| !cleanId(claims.executionId)
			|| typeof configuredTeam === 'string' && !configuredTeam.startsWith('=') && configuredTeam.trim()
				&& configuredTeam.trim() !== value.teamId) throw new Error('execution identity mismatch');
		return { token, principalId: String(claims.principalId), rawTeamId: value.teamId, apiTeamId: value.apiTeamId, executionId: claims.executionId };
	} catch { throw new NodeOperationError(context.getNode(), new TotemStudioV2ClientError('invalid_credentials', 401)); }
}
