import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class ClaudeRefineApi implements ICredentialType {
	name = 'claudeRefineApi';

	displayName = 'Claude Refine API';

	documentationUrl =
		'https://github.com/BenNotix/n8n-nodes-claude-refine?tab=readme-ov-file#credentials';

	icon: Icon = {
		light: 'file:../icons/claude-refine.svg',
		dark: 'file:../icons/claude-refine.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName:
				'Create an API key in the Anthropic Console (console.anthropic.com → API Keys). Workspace-scoped keys are recommended so the node only sees the files and batches of that workspace.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Anthropic API key, starts with sk-ant-',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.anthropic.com',
			description:
				'Base URL of the Anthropic API, without a trailing slash. Change it only when routing through a compatible gateway or proxy.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-api-key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			// Mirrors the runtime normalization: default host, scheme added when
			// missing, trailing slashes removed
			baseURL:
				'={{ (($credentials.baseUrl || "https://api.anthropic.com").trim().toLowerCase().startsWith("http") ? ($credentials.baseUrl || "https://api.anthropic.com").trim() : "https://" + $credentials.baseUrl.trim()).replace(new RegExp("/+$"), "") }}',
			url: '/v1/models',
			qs: {
				limit: 1,
			},
			headers: {
				'anthropic-version': '2023-06-01',
			},
		},
	};
}
