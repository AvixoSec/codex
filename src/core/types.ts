export const ROUTE_ACTIONS = [
  "analyze",
  "inspect",
  "edit",
  "verify",
  "recover",
  "ask_user",
  "finish"
] as const;

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export const TOOL_POLICIES = ["none", "read", "write", "shell"] as const;
export const TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_text",
  "write_file",
  "replace_in_file",
  "run_command"
] as const;

export type RouteAction = (typeof ROUTE_ACTIONS)[number];
export type Effort = (typeof EFFORTS)[number];
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export type ToolName = (typeof TOOL_NAMES)[number];
export type ApprovalMode = "ask" | "allow" | "deny";
export type ProviderApi = "chat-completions" | "responses";

export interface JevConfig {
  endpoint: string;
  apiKeyEnv: string;
  model: string;
  timeoutMs: number;
  retries: number;
}

export interface RouteChoices {
  actions: RouteAction[];
  efforts: Effort[];
  contextTokens: number[];
  maxOutputTokens: number[];
  temperatures: number[];
  toolPolicies: ToolPolicy[];
}

export interface RouteFallback {
  action: RouteAction;
  target: string;
  effort: Effort;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  toolPolicy: ToolPolicy;
}

export interface RoutingConfig {
  confidenceThreshold: number;
  completionThreshold: number;
  safetyMarginTokens: number;
  maxSteps: number;
  maxConsecutiveRouterFailures: number;
  maxProviderFailures: number;
  maxElapsedMs: number;
  shadow: boolean;
  choices: RouteChoices;
  fallback: RouteFallback;
}

export interface TemperatureRange {
  min: number;
  max: number;
}

export interface ModelConfig {
  model?: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  efforts: Effort[];
  effortMap: Partial<Record<Effort, string>>;
  supportsTools: boolean;
  temperature: false | TemperatureRange;
  extraBody: Record<string, unknown>;
}

export interface ProviderConfig {
  baseUrl: string;
  api: ProviderApi;
  apiKeyEnv?: string;
  timeoutMs: number;
  retries: number;
  headersFromEnv: Record<string, string>;
  extraBody: Record<string, unknown>;
  models: Record<string, ModelConfig>;
}

export interface ToolsConfig {
  enabled: ToolName[];
  maxPolicy: ToolPolicy;
  approvals: {
    write: ApprovalMode;
    shell: ApprovalMode;
  };
  safeCommandPrefixes: string[];
  blockedCommandPatterns: string[];
  maxFileBytes: number;
  maxOutputBytes: number;
  maxCommandTimeoutMs: number;
}

export interface ReceiptsConfig {
  enabled: boolean;
  directory: string;
}

export interface HarnessConfig {
  version: 1;
  jev: JevConfig;
  routing: RoutingConfig;
  providers: Record<string, ProviderConfig>;
  tools: ToolsConfig;
  receipts: ReceiptsConfig;
}

export interface TargetDescriptor {
  id: string;
  providerId: string;
  modelId: string;
  apiModel: string;
  description: string;
  baseUrl: string;
  api: ProviderApi;
  provider: ProviderConfig;
  model: ModelConfig;
}

export interface LoadedConfig {
  path: string;
  config: HarnessConfig;
}

export interface AgentTextEvent {
  type: "assistant_text" | "user_text" | "error";
  content: string;
  step: number;
}

export interface AgentToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  step: number;
}

export interface AgentToolResultEvent {
  type: "tool_result";
  callId: string;
  name: string;
  content: string;
  ok: boolean;
  step: number;
}

export type AgentEvent = AgentTextEvent | AgentToolCallEvent | AgentToolResultEvent;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  minimumPolicy: ToolPolicy;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface WorkerResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: WorkerUsage;
  finishReason?: string;
}

export interface BoundedContext {
  goal: string;
  events: AgentEvent[];
  estimatedTokens: number;
  truncated: boolean;
}
