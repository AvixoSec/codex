import type { BoundedContext, HarnessConfig, ToolDefinition, WorkerResult } from "../core/types.js";
import type { ResolvedRoute } from "../router/resolve.js";
import { buildChatCompletionsRequest, parseChatCompletionsResponse } from "./chat-completions.js";
import { endpointUrl, postJson, type HttpDependencies } from "./http.js";
import { buildResponsesRequest, parseResponsesResponse } from "./responses.js";

export interface WorkerInput {
  goal: string;
  context: BoundedContext;
  route: ResolvedRoute;
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface WorkerClient {
  execute(input: WorkerInput): Promise<WorkerResult>;
}

interface WorkerDependencies extends HttpDependencies {
  env?: Record<string, string | undefined>;
}

export class OpenAICompatibleWorkerClient implements WorkerClient {
  readonly #config: HarnessConfig;
  readonly #env: Record<string, string | undefined>;
  readonly #dependencies: HttpDependencies;

  constructor(config: HarnessConfig, dependencies: WorkerDependencies = {}) {
    this.#config = config;
    this.#env = dependencies.env ?? process.env;
    this.#dependencies = {
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.sleep ? { sleep: dependencies.sleep } : {})
    };
  }

  async execute(input: WorkerInput): Promise<WorkerResult> {
    const { provider, model } = input.route.target;
    const headers: Record<string, string> = {};
    if (provider.apiKeyEnv) {
      const secret = this.#env[provider.apiKeyEnv];
      if (!secret) throw new Error(`Missing provider API key environment variable: ${provider.apiKeyEnv}`);
      headers.Authorization = `Bearer ${secret}`;
    }
    for (const [header, envName] of Object.entries(provider.headersFromEnv)) {
      const value = this.#env[envName];
      if (!value) throw new Error(`Missing provider header environment variable: ${envName}`);
      headers[header] = value;
    }
    const requestInput = {
      ...input,
      providerExtraBody: provider.extraBody,
      modelExtraBody: model.extraBody
    };
    const body = provider.api === "responses"
      ? buildResponsesRequest(requestInput)
      : buildChatCompletionsRequest(requestInput);
    const url = endpointUrl(provider.baseUrl, provider.api === "responses" ? "responses" : "chat/completions");
    const payload = await postJson({
      url,
      headers,
      body,
      timeoutMs: provider.timeoutMs,
      retries: provider.retries,
      ...(input.signal ? { signal: input.signal } : {})
    }, this.#dependencies);
    return provider.api === "responses"
      ? parseResponsesResponse(payload, input.tools)
      : parseChatCompletionsResponse(payload, input.tools);
  }
}
