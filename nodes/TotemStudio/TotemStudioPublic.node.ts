import type { IExecuteFunctions, ILoadOptionsFunctions, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { createTotemPublicApiProperties, executeTotemPublicApi, getTotemPublicApiTeamOptions } from './publicApiNode';

/** Public distribution shell: all operations and transport come from the maintained executor. */
export class TotemStudio implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Totem Studio',
		name: 'totemStudioPublic',
		icon: { light: 'file:totemStudio.svg', dark: 'file:totemStudio.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Work with the Totem Studio API using an integration key',
		defaults: { name: 'Totem Studio' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'totemStudioPublicApi', required: true }],
		properties: createTotemPublicApiProperties(),
	};
	methods = {
		loadOptions: {
			async getFamilyWorkspaces(this: ILoadOptionsFunctions) {
				return getTotemPublicApiTeamOptions(this, 'totemStudioPublicApi');
			},
		},
	};
	async execute(this: IExecuteFunctions) {
		return executeTotemPublicApi(this, { credentialType: 'totemStudioPublicApi' });
	}
}

// n8n loads the filename's named export; preserve the existing constructor too.
export { TotemStudio as TotemStudioPublic };
