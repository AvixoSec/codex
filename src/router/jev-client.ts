import type { HarnessConfig } from "../core/types.js";
import { buildQuestions } from "./questions.js";
import type { RawChoiceDecision, RawRouteDecision, RouteField } from "./resolve.js";

export interface DecisionClient {
  decide(snapshot: unknown, signal?: AbortSignal): Promise<RawRouteDecision>;
}

interface JevClientDependencies {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

const ANSWER_FIELDS: Record<string, RouteField> = {
  action: "action",
  target: "target",
  effort: "effort",
  context_tokens: "contextTokens",
  max_output_tokens: "maxOutputTokens",
  temperature: "temperature",
  tool_policy: "toolPolicy"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChoice(value: unknown): { decision?: RawChoiceDecision; error?: string } {
  if (!isRecord(value) || value.type !== "choice") return { error: "answer is not a choice" };
  if (typeof value.choice !== "string") return { error: "choice value is missing" };
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    return { error: "choice confidence must be between 0 and 1" };
  }
  if (!isRecord(value.probabilities)) return { error: "choice probabilities are missing" };
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value.probabilities)) {
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { error: "choice probabilities must be between 0 and 1" };
    }
    probabilities[key] = probability;
  }
  return { decision: { value: value.choice, confidence: value.confidence, probabilities } };
}

function parseDecisionResponse(value: unknown): RawRouteDecision {
  if (!isRecord(value) || !isRecord(value.answers)) {
    throw new Error("Jev response must contain an answers object");
  }
  const decision: RawRouteDecision = { errors: {} };
  for (const [answerName, field] of Object.entries(ANSWER_FIELDS)) {
    const parsed = parseChoice(value.answers[answerName]);
    if (parsed.decision) {
      decision[field] = parsed.decision;
    } else {
      decision.errors[field] = parsed.error ?? "invalid choice answer";
    }
  }

  const completion = value.answers.is_complete;
  if (
    isRecord(completion) &&
    completion.type === "noul" &&
    typeof completion.noul === "number" &&
    Number.isFinite(completion.noul) &&
    completion.noul >= 0 &&
    completion.noul <= 1
  ) {
    decision.completionProbability = completion.noul;
  } else {
    decision.errors.completion = "completion answer must be a Noul value between 0 and 1";
  }

  if (typeof value.model === "string") decision.model = value.model;
  if (isRecord(value.usage)) {
    const input = value.usage.input_tokens;
    const output = value.usage.output_tokens;
    if (typeof input === "number" && Number.isFinite(input) && typeof output === "number" && Number.isFinite(output)) {
      decision.usage = { inputTokens: input, outputTokens: output };
    }
  }
  return decision;
}

function abortSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([timeout, parent]) : timeout;
}

export class JevHttpClient implements DecisionClient {
  readonly #config: HarnessConfig;
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(config: HarnessConfig, dependencies: JevClientDependencies = {}) {
    this.#config = config;
    this.#env = dependencies.env ?? process.env;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = dependencies.random ?? Math.random;
  }

  async decide(snapshot: unknown, signal?: AbortSignal): Promise<RawRouteDecision> {
    const apiKey = this.#env[this.#config.jev.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing Jev API key environment variable: ${this.#config.jev.apiKeyEnv}`);
    }
    const body = JSON.stringify({
      state: snapshot,
      model: this.#config.jev.model,
      questions: buildQuestions(this.#config)
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#config.jev.retries; attempt += 1) {
      try {
        const response = await this.#fetch(this.#config.jev.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body,
          signal: abortSignal(this.#config.jev.timeoutMs, signal)
        });
        const text = await response.text();
        if (text.length > 2_000_000) throw new Error("Jev response exceeded 2 MB");
        if (!response.ok) {
          const error = new Error(`Jev HTTP ${response.status}: ${text.slice(0, 500)}`);
          if ((response.status === 429 || response.status === 529 || response.status >= 500) && attempt < this.#config.jev.retries) {
            lastError = error;
            await this.#backoff(attempt);
            continue;
          }
          throw error;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error("Jev returned invalid JSON");
        }
        return parseDecisionResponse(payload);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt >= this.#config.jev.retries || !this.#isTransient(error)) throw error;
        await this.#backoff(attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Jev request failed");
  }

  #isTransient(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (/Jev HTTP (4\d\d)/.test(error.message) && !/Jev HTTP 429/.test(error.message)) return false;
    return true;
  }

  async #backoff(attempt: number): Promise<void> {
    const delay = Math.min(2_000, 100 * (2 ** attempt)) + Math.floor(this.#random() * 50);
    await this.#sleep(delay);
  }
}
