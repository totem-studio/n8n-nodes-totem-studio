import type { IExecuteFunctions, NodeTypeAndVersion } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

/** n8n normalizes an omitted or null hidden value to its declared default. */
export const INHERIT_TOTEM_EXECUTION_CONTEXT = '__totem_inherit_execution_context_v1__';

const TRUSTED_INGRESS_TYPES = new Set([
	'CUSTOM.totemStudioTrigger',
	'CUSTOM.totemStudioDraftTrigger',
	'CUSTOM.totemStudioToolTrigger',
	'n8n-nodes-totem-studio.totemStudioTrigger',
	'n8n-nodes-totem-studio.totemStudioDraftTrigger',
	'n8n-nodes-totem-studio.totemStudioToolTrigger',
]);
const CALL_TOOL_INGRESS_TYPES = new Set([
	'CUSTOM.totemStudioCallToolTrigger',
	'n8n-nodes-totem-studio.totemStudioCallToolTrigger',
]);

type Context = Pick<IExecuteFunctions,
	'getNode' | 'getParentNodes' | 'getInputSourceData' | 'evaluateExpression' | 'getNodeParameter' | 'getMode'>;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as RecordValue : null;
}

function mainParents(context: Context, nodeName: string): NodeTypeAndVersion[] {
	return context.getParentNodes(nodeName, {
		connectionType: NodeConnectionTypes.Main,
		includeNodeParameters: true,
	});
}

function ingressParents(context: Context): NodeTypeAndVersion[] {
	const node = context.getNode();
	if (node.rewireOutputLogTo !== NodeConnectionTypes.AiTool) return mainParents(context, node.name);
	// A tool has no Main input from its requesting Agent. The engine records
	// that requester separately; the tool's own Main ancestors are unrelated.
	const source = context.getInputSourceData();
	if (!source?.previousNode || source.previousNode === node.name) {
		throw new Error('Totem execution context has no valid requesting node');
	}
	const tools = context.getParentNodes(source.previousNode, {
		connectionType: NodeConnectionTypes.AiTool,
		depth: 1,
	});
	if (!tools.some(tool => tool.name === node.name && tool.type === node.type)) {
		throw new Error('Totem execution context requester is not connected to this tool');
	}
	return mainParents(context, source.previousNode);
}

/** The same real engine provenance serves both saved v1 and public v2 actions. */
export function totemExecutionIngressParents(context: Context): NodeTypeAndVersion[] {
	return ingressParents(context).filter(node =>
		!node.disabled && ((node.typeVersion === 1 && TRUSTED_INGRESS_TYPES.has(node.type))
			// v1 already executed its business handler before publishing output.
			// Only the ingress-only version may authorize the following API graph.
			|| (node.typeVersion === 2 && CALL_TOOL_INGRESS_TYPES.has(node.type))));
}

/** Only this genuinely executed private source adapter may replace input authority with a prepared whole-batch proof. */
export function totemExecutionSourceParents(context: Context): NodeTypeAndVersion[] {
	return ingressParents(context).filter(node => !node.disabled && node.typeVersion === 1
		&& ['CUSTOM.totemStudioMessageSource', 'n8n-nodes-totem-studio.totemStudioMessageSource',
			'CUSTOM.totemStudioAuxiliarySource'].includes(node.type));
}

function literalTeam(value: unknown): string {
	return typeof value === 'string' && !value.startsWith('=') ? value.trim() : '';
}

/**
 * Resolve only the schema's inheritance marker, never a present node value.
 * Authority comes from an executed, typed ingress in this run, not current
 * input JSON or model arguments. Totem still verifies signature/team/binding.
 * An omitted token keeps compatibility; a supplied bad token never falls back.
 */
export function resolveLegacyExecutionContext(context: Context, itemIndex: number, rawContext: unknown): unknown {
	if (rawContext !== INHERIT_TOTEM_EXECUTION_CONTEXT) return rawContext;
	// Manual expressions can substitute pinned data when an executed node's
	// output cannot be read. Only explicit node authority is accepted there.
	if (context.getMode() === 'manual') return '';
	const candidates = totemExecutionIngressParents(context);
	let inherited: unknown = '';
	let executed = 0;
	for (const candidate of candidates) {
		const selected = `$(${JSON.stringify(candidate.name)})`;
		const evidence = context.evaluateExpression(
			`{{ ${selected}.isExecuted ? ({ token: ${selected}.first().json.automationWriteContext, teamId: ${selected}.first().json.teamId || ${selected}.first().json.team_id || '' }) : null }}`,
			itemIndex,
		);
		if (evidence === null) continue;
		const value = record(evidence);
		if (!value) throw new Error('Totem execution context ingress could not be read');
		if (++executed > 1) throw new Error('Totem execution context has multiple executed ingresses');
		const teamId = String(context.getNodeParameter('teamId', itemIndex, '') || '').trim();
		for (const sourceTeam of [literalTeam(candidate.parameters?.teamId), literalTeam(value.teamId)]) {
			if (teamId && sourceTeam && teamId !== sourceTeam) {
				throw new Error('Totem execution context ingress belongs to a different team');
			}
		}
		if (value.token === undefined) continue;
		if (typeof value.token !== 'string' || value.token.length > 16_384
			|| !/^taw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token)) {
			throw new Error('Totem execution context ingress contains invalid authority');
		}
		inherited = value.token;
	}
	return inherited;
}
