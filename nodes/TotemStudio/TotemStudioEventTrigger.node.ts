import type { ILoadOptionsFunctions, INodeType, INodeTypeDescription, IPollFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { getTotemPublicApiTeamOptions } from './publicApiNode';
import { pollTotemStudioEvents } from './publicApiEvents';

/** Public tenant event ingress. Business actions remain in the one shared Totem Studio node. */
export class TotemStudioEventTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Totem Studio Events Trigger', subtitle: 'Lifecycle metadata', name: 'totemStudioEventTrigger',
		icon: { light: 'file:totemStudio.svg', dark: 'file:totemStudio.dark.svg' },
		group: ['trigger'], version: 1, description: 'Start workflows from authorized Totem lifecycle events',
		defaults: { name: 'Totem Studio Events' }, polling: true,
		inputs: [], outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'totemStudioPublicApi', required: true }],
		properties: [
			{ displayName: 'Lifecycle events require events:read. This trigger emits metadata, not message bodies or call transcripts. An accepted request is distinct from a completed action. Manual tests read retained events without changing the saved cursor.', name: 'eventNotice', type: 'notice', default: '' },
			{ displayName: 'Workspace Name or ID', name: 'teamId', type: 'options', typeOptions: { loadOptionsMethod: 'getFamilyWorkspaces' }, default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				hint: 'Leave empty only for a key with one workspace.' },
			{ displayName: 'First Activation', name: 'initialEvents', type: 'options', default: 'now', options: [
				{ name: 'New Events Only', value: 'now', description: 'Initialize at the current event position without replaying earlier automations' },
				{ name: 'Replay Retained Events', value: 'retained', description: 'Intentionally replay authorized retained history when this connection has no saved cursor' },
			], description: 'Used only when initializing a workspace and connection; later polls resume the opaque saved cursor' },
			{ displayName: 'Advanced', name: 'advanced', type: 'collection', placeholder: 'Add Option', default: {}, options: [
				{ displayName: 'Restart Counter', name: 'restartCounter', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: Number.MAX_SAFE_INTEGER },
					description: 'Increase manually to restart using First Activation. Keep unchanged for normal polling. An expired cursor never replays automatically.' },
			] },
		],
	};
	methods = { loadOptions: { async getFamilyWorkspaces(this: ILoadOptionsFunctions) { return getTotemPublicApiTeamOptions(this, 'totemStudioPublicApi'); } } };
	async poll(this: IPollFunctions) { return pollTotemStudioEvents(this); }
}
