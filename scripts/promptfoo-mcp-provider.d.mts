export interface PromptfooProviderOptions {
  id?: string;
  label?: string;
  config?: {
    model?: string;
    serverUrl?: string;
    server?: { url?: string };
    apiBaseUrl?: string;
    apiKeyEnvar?: string;
  };
  fetchFn?: typeof fetch;
}

export declare function callMcpTool(
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  customFetch?: typeof fetch
): Promise<Array<{ type: string; text?: string; [key: string]: unknown }>>;

export default class CampervanPromptfooProvider {
  constructor(options?: PromptfooProviderOptions);
  id(): string;
  callApi(prompt: string, context?: unknown): Promise<{ output?: string; error?: string }>;
}
