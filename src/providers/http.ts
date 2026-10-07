export interface HttpDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

function combinedSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([timeout, parent]) : timeout;
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  if (typeof code === "string") return code;
  return errorCode(Reflect.get(error, "cause"));
}

export function isTransientNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const code = errorCode(error);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return error instanceof TypeError && /(?:fetch failed|failed to fetch|network ?error|socket|connection|terminated)/iu.test(error.message);
}

export async function postJson(
  options: PostJsonOptions,
  dependencies: HttpDependencies = {}
): Promise<unknown> {
  const fetcher = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(options.url, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify(options.body),
        signal: combinedSignal(options.timeoutMs, options.signal)
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt >= options.retries || !isTransientNetworkFailure(error)) throw error;
      await sleep(Math.min(2_000, 150 * (2 ** attempt)));
      continue;
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > (options.maxResponseBytes ?? 10_000_000)) {
      throw new Error("Provider response exceeded the configured byte limit");
    }
    if (!response.ok) {
      const error = new Error(`Provider HTTP ${response.status}: ${text.slice(0, 500)}`);
      if (retryable(response.status) && attempt < options.retries) {
        lastError = error;
        await sleep(Math.min(2_000, 150 * (2 ** attempt)));
        continue;
      }
      throw error;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Provider returned invalid JSON");
    }
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      throw new Error(`Provider returned an error object: ${JSON.stringify((payload as { error: unknown }).error).slice(0, 500)}`);
    }
    return payload;
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

export function endpointUrl(baseUrl: string, path: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//u, ""), normalized).toString();
}
