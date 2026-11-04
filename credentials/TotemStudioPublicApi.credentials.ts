import type { ICredentialType, Icon } from 'n8n-workflow';
import { publicApiAuthentication, publicApiConnectionTest, publicApiCredentialProperties } from './publicApiCredential';

/** Public-only connection. The internal credential class and its legacy default are unchanged. */
export class TotemStudioPublicApi implements ICredentialType {
	name = 'totemStudioPublicApi';
	displayName = 'Totem Studio Public API';
	icon: Icon = { light: 'file:totemStudio.svg', dark: 'file:totemStudio.dark.svg' };
	documentationUrl = 'https://totemstudio.ai/developers/authentication';
	properties = publicApiCredentialProperties('apiAccessNotice');
	authenticate = publicApiAuthentication();
	test = publicApiConnectionTest();
}
