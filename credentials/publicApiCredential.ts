import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	INodeProperties,
} from 'n8n-workflow';

/** Shared public connection contract; internal credential modes keep their own defaults. */
export function publicApiKeyProperty(description?: string): INodeProperties {
	return {
		displayName: 'API Key',
		name: 'accessToken',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		required: true,
		description:
			description ??
			'The tsk_live_ secret shown once by Settings → Developers. Revoking its integration disables this connection.',
	};
}

export function publicApiCredentialProperties(
	noticeName = 'tenantAccessNotice',
): INodeProperties[] {
	return [
		{
			displayName: 'Totem API Access',
			name: noticeName,
			type: 'notice',
			default: '',
			description:
				'Create a separate integration key in Totem Studio Settings → Developers. The key accesses only its explicitly authorized workspaces and permissions. Never use an internal Cloud Functions or fleet webhook key here.',
		},
		publicApiKeyProperty(),
	];
}

export function publicApiAuthentication(): IAuthenticateGeneric {
	return {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } },
	};
}

export function publicApiConnectionTest(): ICredentialTestRequest {
	return {
		request: {
			baseURL: 'https://api.totemstudio.ai',
			url: '/v1/me',
			method: 'GET',
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
				Accept: 'application/json',
			},
			json: true,
			timeout: 15_000,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
		},
		rules: [
			{
				type: 'responseCode',
				properties: { value: 401, message: 'The Totem Studio API key is invalid or expired.' },
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message: 'This Totem Studio connection is suspended or unavailable.',
				},
			},
		],
	};
}
