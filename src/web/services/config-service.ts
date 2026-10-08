import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { atomicReplace } from "./atomic-file.js";
import { withPathMutation } from "./mutation-queue.js";
import { harnessConfigSchema, parseConfig } from "../../config/schema.js";
import { z } from "zod";
import { EFFORTS, type HarnessConfig, type LoadedConfig } from "../../core/types.js";
import type { WebConfigDocument, WebConfigEditor, WebConfigValidation, WebErrorEnvelope } from "../contracts.js";

const messages = {
  CONFIG_IO: [500, "Configuration could not be accessed."],
  INVALID_CONFIG: [400, "Invalid configuration."],
  INVALID_REVISION: [400, "Invalid configuration revision."],
  CONFIG_CONFLICT: [412, "Configuration has changed."],
  INVALID_CREDENTIAL: [400, "Invalid credential name."],
  AMBIGUOUS_CREDENTIAL: [409, "Credential assignment is ambiguous."],
  CREDENTIAL_IO: [500, "Credential could not be accessed."],
  INVALID_RECEIPT: [400, "Invalid receipt request."],
  RECEIPT_NOT_FOUND: [404, "Run history was not found."],
  UNSUPPORTED_RECEIPT: [422, "Run history is unsupported."],
  RECEIPT_IO: [500, "Run history could not be accessed."]
} as const;
export class ServiceError extends Error {
  readonly status: number;
  readonly details?: { currentRevision: string };
  constructor(readonly code: keyof typeof messages, currentRevision?: string) {
    super(messages[code][1]); this.name = "ServiceError"; this.status = messages[code][0];
    if (code === "CONFIG_CONFLICT" && currentRevision !== undefined) this.details = { currentRevision };
  }
  toEnvelope(): WebErrorEnvelope<{ currentRevision: string }> {
    return { error: { code: this.code, message: messages[this.code][1], ...(this.details ? { details: { currentRevision: this.details.currentRevision } } : {}) } };
  }
}
function revision(bytes: Uint8Array): string { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
const shape = harnessConfigSchema.shape;
const providerShape = shape.providers.valueType.shape;
const modelShape = providerShape.models.valueType;
const boundedString = z.string().min(1).max(2048);
const identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/u);
const environmentName = z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const modelEditorSchema = z.strictObject({ model: boundedString.optional(), description: boundedString,
  contextWindow: modelShape.shape.contextWindow, maxOutputTokens: modelShape.shape.maxOutputTokens,
  efforts: modelShape.shape.efforts.max(6), effortMap: z.partialRecord(z.enum(EFFORTS), boundedString),
  supportsTools: modelShape.shape.supportsTools, temperature: modelShape.shape.temperature });
const editorSchema = z.strictObject({
  version: z.literal(1),
  jev: z.strictObject({ apiKeyEnv: environmentName, model: boundedString, timeoutMs: positiveInteger, retries: z.number().int().min(0).max(8) }),
  routing: shape.routing.extend({ shadow: z.boolean() }),
  providers: z.record(identifier, z.strictObject({
    baseUrl: z.url().max(2048), api: providerShape.api, apiKeyEnv: environmentName.optional(),
    timeoutMs: positiveInteger, retries: z.number().int().min(0).max(5),
    models: z.record(identifier, modelEditorSchema).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 255)
  })).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 255),
  tools: shape.tools.omit({ safeCommandPrefixes: true, blockedCommandPatterns: true })
});
function validateEditor(value: unknown): WebConfigValidation {
  const result = editorSchema.safeParse(value);
  if (!result.success) {
    const known = new Set(["version", "jev", "routing", "providers", "models", "tools", "apiKeyEnv", "model", "description", "contextWindow", "maxOutputTokens", "efforts", "effortMap", "supportsTools", "temperature", "min", "max", "baseUrl", "api", "timeoutMs", "retries", "enabled", "maxPolicy", "approvals", "write", "shell", "maxFileBytes", "maxOutputBytes", "maxCommandTimeoutMs", "choices", "fallback", "action", "target", "effort", "contextTokens", "toolPolicy"]);
    return { valid: false, issues: result.error.issues.slice(0, 100).map((issue) => ({
      path: issue.path.slice(0, 16).map((part) => typeof part === "number" ? Math.min(1000000, Math.max(0, part)) : known.has(String(part)) ? String(part) : "entry"),
      code: "INVALID_FIELD", message: "Invalid configuration field."
    })) };
  }
  try {
    // Apply all existing version-1 cross-field checks without accepting hidden editor fields.
    const editor = result.data;
    const providers: Record<string, unknown> = Object.create(null);
    for (const [id, provider] of Object.entries(editor.providers)) {
      const models: Record<string, unknown> = Object.create(null);
      for (const [modelId, model] of Object.entries(provider.models)) models[modelId] = { ...model, extraBody: {} };
      providers[id] = { ...provider, models, extraBody: {}, headersFromEnv: {} };
    }
    parseConfig({ ...editor, providers, receipts: { enabled: false, directory: ".receipts" } });
    // Bound numbers and choice collections independently of version-1's looser runtime schema.
    const stack: unknown[] = [editor];
    while (stack.length) {
      const item = stack.pop();
      if (typeof item === "number" && (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER)) throw new Error();
      if (typeof item === "string" && Buffer.byteLength(item, "utf8") > 8192) throw new Error();
      if (Array.isArray(item) && item.length > 255) throw new Error();
      if (item && typeof item === "object") for (const child of Object.values(item)) stack.push(child);
    }
    return { valid: true, issues: [] };
  } catch { return { valid: false, issues: [{ path: [], code: "INVALID_CONFIG", message: "Invalid configuration." }] }; }
}
function project(config: HarnessConfig): WebConfigEditor {
  const providers: WebConfigEditor["providers"] = Object.create(null);
  for (const [id, provider] of Object.entries(config.providers)) {
    const models: WebConfigEditor["providers"][string]["models"] = Object.create(null);
    for (const [modelId, model] of Object.entries(provider.models)) {
      models[modelId] = { ...(model.model === undefined ? {} : { model: model.model }), description: model.description,
        contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, efforts: [...model.efforts], effortMap: { ...model.effortMap }, supportsTools: model.supportsTools,
        temperature: model.temperature === false ? false : { min: model.temperature.min, max: model.temperature.max } };
    }
    providers[id] = { baseUrl: provider.baseUrl, api: provider.api, ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv }), timeoutMs: provider.timeoutMs, retries: provider.retries, models };
  }
  return { version: 1, jev: { apiKeyEnv: config.jev.apiKeyEnv, model: config.jev.model, timeoutMs: config.jev.timeoutMs, retries: config.jev.retries },
    routing: structuredClone(config.routing), providers,
    tools: { enabled: [...config.tools.enabled], maxPolicy: config.tools.maxPolicy, approvals: { ...config.tools.approvals }, maxFileBytes: config.tools.maxFileBytes, maxOutputBytes: config.tools.maxOutputBytes, maxCommandTimeoutMs: config.tools.maxCommandTimeoutMs } };
}
export class ConfigService {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  private async baseline(): Promise<{ bytes: Buffer; config: HarnessConfig }> {
    try { const bytes = await readFile(this.path); return { bytes, config: parseConfig(parse(bytes.toString("utf8"))) }; }
    catch { throw new ServiceError("CONFIG_IO"); }
  }
  async read(): Promise<WebConfigDocument> { const { bytes, config } = await this.baseline(); return { revision: revision(bytes), config: project(config) }; }
  validate(value: unknown): WebConfigValidation { return validateEditor(value); }
  async update(value: unknown, expectedRevision: string): Promise<WebConfigDocument> {
    if (typeof expectedRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(expectedRevision)) throw new ServiceError("INVALID_REVISION");
    if (!this.validate(value).valid) throw new ServiceError("INVALID_CONFIG");
    const editor = structuredClone(value) as WebConfigEditor;
    try { return await withPathMutation(this.path, async () => {
    const { config, bytes } = await this.baseline();
    const currentRevision = revision(bytes);
    if (expectedRevision !== currentRevision) throw new ServiceError("CONFIG_CONFLICT", currentRevision);
    const providers: HarnessConfig["providers"] = Object.create(null);
    for (const id of Object.keys(editor.providers).sort()) {
      const provider = editor.providers[id]!;
      const old = Object.hasOwn(config.providers, id) ? config.providers[id] : undefined;
      const models: HarnessConfig["providers"][string]["models"] = Object.create(null);
      for (const modelId of Object.keys(provider.models).sort()) models[modelId] = { ...provider.models[modelId]!, extraBody: old && Object.hasOwn(old.models, modelId) ? old.models[modelId]!.extraBody : {} };
      providers[id] = { ...provider, models, headersFromEnv: old?.headersFromEnv ?? {}, extraBody: old?.extraBody ?? {} };
    }
    let merged: HarnessConfig;
    try { merged = parseConfig({ version: 1, jev: { ...editor.jev, endpoint: config.jev.endpoint }, routing: editor.routing, providers,
      tools: { ...editor.tools, safeCommandPrefixes: config.tools.safeCommandPrefixes, blockedCommandPatterns: config.tools.blockedCommandPatterns }, receipts: config.receipts }); }
    catch { throw new ServiceError("INVALID_CONFIG"); }
    // Sorted YAML maps, LF separators, exactly one final LF.
    const output = Buffer.from(stringify(merged, { sortMapEntries: true, lineWidth: 0 }), "utf8");
    try { await atomicReplace(this.path, output); } catch { throw new ServiceError("CONFIG_IO"); }
    return { revision: revision(output), config: project(merged) };
    }); } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError("CONFIG_IO"); }
  }
  async loadInternal(): Promise<LoadedConfig> { return { path: this.path, config: (await this.baseline()).config }; }
}
