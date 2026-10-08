export const MANAGED_CREDENTIAL_PREFIX = "JEVH_MANAGED_B64_V1:";
export function encodeManagedCredential(value: string): string {
  return MANAGED_CREDENTIAL_PREFIX + Buffer.from(value, "utf8").toString("base64");
}
export function decodeManagedCredential(value: string): string {
  if (!value.startsWith(MANAGED_CREDENTIAL_PREFIX)) return value;
  const suffix = value.slice(MANAGED_CREDENTIAL_PREFIX.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(suffix)) return value;
  const bytes = Buffer.from(suffix, "base64");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) && bytes.toString("base64") === suffix ? decoded : value;
}

interface Assignment { name: string; value: string; start: number; end: number }
export interface DotenvDocument {
  values: Record<string, string>;
  assignments: readonly Assignment[];
  separator: Buffer;
  finalSeparator: boolean;
}
function separatorLength(bytes: Buffer, offset: number): number {
  if (bytes[offset] === 10) return 1;
  if (bytes[offset] === 13) return bytes[offset + 1] === 10 ? 2 : 1;
  return bytes[offset] === 0xe2 && bytes[offset + 1] === 0x80 && (bytes[offset + 2] === 0xa8 || bytes[offset + 2] === 0xa9) ? 3 : 0;
}
function lineEnd(bytes: Buffer, start: number): number {
  let end = start; while (end < bytes.length && !separatorLength(bytes, end)) end += 1; return end;
}
export function parseDotenv(input: Uint8Array): DotenvDocument {
  const bytes = Buffer.from(input);
  const counts = new Map<string, { bytes: Buffer; count: number }>();
  let finalSeparator = false;
  for (let i = 0; i < bytes.length;) {
    const length = separatorLength(bytes, i);
    if (!length) { i += 1; continue; }
    const raw = bytes.subarray(i, i + length); const key = raw.toString("hex");
    const existing = counts.get(key); if (existing) existing.count += 1; else counts.set(key, { bytes: raw, count: 1 });
    i += length; if (i === bytes.length) finalSeparator = true;
  }
  let separator = Buffer.from("\n"); let greatest = 0;
  for (const candidate of counts.values()) if (candidate.count > greatest) { greatest = candidate.count; separator = Buffer.from(candidate.bytes); }
  const values: Record<string, string> = Object.create(null); const assignments: Assignment[] = [];
  let start = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  while (start < bytes.length) {
    let end = lineEnd(bytes, start);
    const header = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*/u.exec(bytes.subarray(start, end).toString("utf8"));
    if (!header) { start = end + separatorLength(bytes, end); continue; }
    const valueStart = start + Buffer.byteLength(header[0]); const quote = bytes[valueStart];
    let value: string;
    if (quote === 34 || quote === 39) {
      let cursor = valueStart + 1; let escaped = false;
      for (; cursor < bytes.length; cursor += 1) {
        const byte = bytes[cursor];
        if (byte === quote && !(quote === 34 && escaped)) break;
        escaped = byte === 92 ? !escaped : false;
      }
      if (cursor === bytes.length) { start = end + separatorLength(bytes, end); continue; }
      value = bytes.subarray(valueStart + 1, cursor).toString("utf8");
      if (quote === 34) value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r");
      end = lineEnd(bytes, cursor + 1);
    } else {
      let comment = valueStart; while (comment < end && bytes[comment] !== 35) comment += 1;
      value = bytes.subarray(valueStart, comment).toString("utf8").trim();
    }
    const name = header[1]!; values[name] = value; assignments.push({ name, value, start, end });
    start = end + separatorLength(bytes, end);
  }
  return { values, assignments, separator, finalSeparator };
}
export function editDotenv(input: Uint8Array, name: string, value: string): Buffer {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("Invalid credential name.");
  const bytes = Buffer.from(input); const document = parseDotenv(bytes);
  const matches = document.assignments.filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error("Credential assignment is ambiguous.");
  const target = matches[0];
  const assignment = Buffer.from(name + "=" + encodeManagedCredential(value));
  if (!target) return Buffer.concat([bytes,
    bytes.length && !document.finalSeparator ? document.separator : Buffer.alloc(0), assignment,
    document.finalSeparator ? document.separator : Buffer.alloc(0)]);
  return Buffer.concat([bytes.subarray(0, target.start), assignment, bytes.subarray(target.end)]);
}
