/**
 * Replace configured secret values without changing value types. Object keys
 * are sanitized too so an echoed credential cannot leak as a property name.
 *
 * Receipt redaction additionally masks fields whose names look sensitive. That
 * behaviour is useful on disk, but is too destructive for runtime objects such
 * as `contextTokens`. The runner only needs value-based redaction at trust
 * boundaries, so it uses this narrower helper.
 */
export function sanitizeKnownSecrets<T>(value: T, secrets: readonly string[]): T {
  const needles = [...new Set(secrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  if (needles.length === 0) return value;

  const mask = (current: string) => needles.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"),
    current
  );
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return mask(current);
    if (Array.isArray(current)) {
      const output: unknown[] = [];
      seen.set(current, output);
      output.push(...current.map(visit));
      return output;
    }
    if (typeof current !== "object" || current === null) return current;
    const previous = seen.get(current);
    if (previous !== undefined) return previous;
    const output: Record<string, unknown> = {};
    seen.set(current, output);
    for (const [key, child] of Object.entries(current)) output[mask(key)] = visit(child);
    return output;
  };

  return visit(value) as T;
}

export function sanitizeString(value: string, secrets: readonly string[]): string {
  return sanitizeKnownSecrets(value, secrets);
}
