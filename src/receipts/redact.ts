const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie/i;
const SAFE_NUMERIC_KEYS = new Set([
  "contextTokens",
  "maxOutputTokens",
  "inputTokens",
  "outputTokens",
  "contextEstimatedTokens"
]);

function maskString(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key) && !(typeof current === "number" && SAFE_NUMERIC_KEYS.has(key))) {
      return "[REDACTED]";
    }
    if (typeof current === "string") return maskString(current, secrets);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (typeof current !== "object" || current === null) return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    return Object.fromEntries(
      Object.entries(current).map(([childKey, child]) => [childKey, visit(child, childKey)])
    );
  };
  return visit(value);
}
