import { z } from "zod";

import {
  EFFORTS,
  ROUTE_ACTIONS,
  TOOL_NAMES,
  TOOL_POLICIES,
  type HarnessConfig,
  type TargetDescriptor
} from "../core/types.js";

const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/);
const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const positiveInteger = z.number().int().positive();
const effortSchema = z.enum(EFFORTS);
const actionSchema = z.enum(ROUTE_ACTIONS);
const toolPolicySchema = z.enum(TOOL_POLICIES);

function uniqueArray<T>(schema: z.ZodType<T>, label: string) {
  return z.array(schema).min(1).superRefine((items, context) => {
    if (new Set(items).size !== items.length) {
      context.addIssue({ code: "custom", message: `${label} must not contain duplicates` });
    }
  });
}

const modelSchema = z.strictObject({
  model: z.string().min(1).optional(),
  description: z.string().min(1),
  contextWindow: positiveInteger,
  maxOutputTokens: positiveInteger,
  efforts: uniqueArray(effortSchema, "model efforts"),
  effortMap: z.partialRecord(effortSchema, z.string().min(1)).default({}),
  supportsTools: z.boolean(),
  temperature: z.union([
    z.literal(false),
    z.strictObject({
      min: z.number().finite().min(0).max(2),
      max: z.number().finite().min(0).max(2)
    }).refine((value) => value.max >= value.min, "temperature max must be >= min")
  ]),
  extraBody: z.record(z.string(), z.unknown()).default({})
}).superRefine((model, context) => {
  if (model.maxOutputTokens >= model.contextWindow) {
    context.addIssue({
      code: "custom",
      path: ["maxOutputTokens"],
      message: "model maxOutputTokens must be smaller than contextWindow"
    });
  }
});

const providerSchema = z.strictObject({
  baseUrl: z.url(),
  api: z.enum(["chat-completions", "responses"]),
  apiKeyEnv: envNameSchema.optional(),
  timeoutMs: positiveInteger.default(120_000),
  headersFromEnv: z.record(z.string().min(1), envNameSchema).default({}),
  extraBody: z.record(z.string(), z.unknown()).default({}),
  models: z.record(idSchema, modelSchema).refine(
    (models) => Object.keys(models).length > 0,
    "provider must declare at least one model"
  )
});

const choicesSchema = z.strictObject({
  actions: uniqueArray(actionSchema, "actions"),
  efforts: uniqueArray(effortSchema, "efforts"),
  contextTokens: uniqueArray(positiveInteger, "contextTokens"),
  maxOutputTokens: uniqueArray(positiveInteger, "maxOutputTokens"),
  temperatures: uniqueArray(z.number().finite().min(0).max(2), "temperatures"),
  toolPolicies: uniqueArray(toolPolicySchema, "toolPolicies")
});

const fallbackSchema = z.strictObject({
  action: actionSchema,
  target: z.string().min(3),
  effort: effortSchema,
  contextTokens: positiveInteger,
  maxOutputTokens: positiveInteger,
  temperature: z.number().finite().min(0).max(2),
  toolPolicy: toolPolicySchema
});

const rawHarnessConfigSchema = z.strictObject({
  version: z.literal(1),
  jev: z.strictObject({
    endpoint: z.url().default("https://api.typesafe.ai/v1/systemone"),
    apiKeyEnv: envNameSchema.default("TYPESAFE_API_KEY"),
    model: z.string().min(1).default("jev-latest"),
    timeoutMs: positiveInteger.default(5_000),
    retries: z.number().int().min(0).max(8).default(2)
  }),
  routing: z.strictObject({
    confidenceThreshold: z.number().finite().min(0).max(1),
    completionThreshold: z.number().finite().min(0).max(1),
    safetyMarginTokens: z.number().int().min(0),
    maxSteps: positiveInteger.max(1_000),
    maxConsecutiveRouterFailures: positiveInteger.max(20),
    maxProviderFailures: positiveInteger.max(20),
    maxElapsedMs: positiveInteger,
    shadow: z.boolean().default(false),
    choices: choicesSchema,
    fallback: fallbackSchema
  }),
  providers: z.record(idSchema, providerSchema).refine(
    (providers) => Object.keys(providers).length > 0,
    "at least one provider is required"
  ),
  tools: z.strictObject({
    enabled: uniqueArray(z.enum(TOOL_NAMES), "enabled tools"),
    maxPolicy: toolPolicySchema,
    approvals: z.strictObject({
      write: z.enum(["ask", "allow", "deny"]),
      shell: z.enum(["ask", "allow", "deny"])
    }),
    safeCommandPrefixes: z.array(z.string().trim().min(1)).default([]),
    blockedCommandPatterns: z.array(z.string().min(1)).default([]),
    maxFileBytes: positiveInteger,
    maxOutputBytes: positiveInteger,
    maxCommandTimeoutMs: positiveInteger
  }),
  receipts: z.strictObject({
    enabled: z.boolean().default(true),
    directory: z.string().trim().min(1).default(".jev-harness/runs")
  })
}).superRefine((config, context) => {
  const targets = new Set<string>();
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const modelId of Object.keys(provider.models)) {
      targets.add(`${providerId}/${modelId}`);
    }
  }

  if (targets.size > 255) {
    context.addIssue({
      code: "custom",
      path: ["providers"],
      message: "Jev Choice supports at most 255 provider/model targets"
    });
  }
  if (!targets.has(config.routing.fallback.target)) {
    context.addIssue({
      code: "custom",
      path: ["routing", "fallback", "target"],
      message: "fallback target must reference a configured provider/model"
    });
  }

  const checks: Array<[unknown, readonly unknown[], PropertyKey[]]> = [
    [config.routing.fallback.action, config.routing.choices.actions, ["routing", "fallback", "action"]],
    [config.routing.fallback.effort, config.routing.choices.efforts, ["routing", "fallback", "effort"]],
    [config.routing.fallback.contextTokens, config.routing.choices.contextTokens, ["routing", "fallback", "contextTokens"]],
    [config.routing.fallback.maxOutputTokens, config.routing.choices.maxOutputTokens, ["routing", "fallback", "maxOutputTokens"]],
    [config.routing.fallback.temperature, config.routing.choices.temperatures, ["routing", "fallback", "temperature"]],
    [config.routing.fallback.toolPolicy, config.routing.choices.toolPolicies, ["routing", "fallback", "toolPolicy"]]
  ];
  for (const [value, choices, path] of checks) {
    if (!choices.includes(value)) {
      context.addIssue({ code: "custom", path, message: "fallback value must be present in its choices" });
    }
  }

  if (!config.routing.choices.toolPolicies.includes(config.tools.maxPolicy)) {
    context.addIssue({
      code: "custom",
      path: ["tools", "maxPolicy"],
      message: "maxPolicy must be present in routing toolPolicies"
    });
  }

  for (const [index, pattern] of config.tools.blockedCommandPatterns.entries()) {
    try {
      new RegExp(pattern, "u");
    } catch {
      context.addIssue({
        code: "custom",
        path: ["tools", "blockedCommandPatterns", index],
        message: "blocked command pattern must be a valid regular expression"
      });
    }
  }
});

export const harnessConfigSchema = rawHarnessConfigSchema;

export function parseConfig(value: unknown): HarnessConfig {
  return harnessConfigSchema.parse(value) as HarnessConfig;
}

export function listTargets(config: HarnessConfig): TargetDescriptor[] {
  return Object.entries(config.providers).flatMap(([providerId, provider]) =>
    Object.entries(provider.models).map(([modelId, model]) => ({
      id: `${providerId}/${modelId}`,
      providerId,
      modelId,
      apiModel: model.model ?? modelId,
      description: model.description,
      baseUrl: provider.baseUrl,
      api: provider.api,
      provider,
      model
    }))
  );
}
