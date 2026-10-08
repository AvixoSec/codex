/** Public run identifiers are opaque, bounded and safe as one path segment. */
export function isValidRunId(value: string): boolean {
  return /^run_[A-Za-z0-9_-]{1,120}$/u.test(value);
}
