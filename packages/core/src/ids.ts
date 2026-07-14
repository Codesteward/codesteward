/** Simple cuid-like IDs for sessions, findings, units (no external dep). */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomChunk(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Base36 timestamp prefix + random suffix. */
export function createId(prefix?: string): string {
  const ts = Date.now().toString(36);
  const body = `${ts}${randomChunk(12)}`;
  return prefix ? `${prefix}_${body}` : body;
}

export function sessionId(): string {
  return createId("ses");
}

export function findingId(): string {
  return createId("fnd");
}

export function unitId(): string {
  return createId("unt");
}

export function evidenceId(): string {
  return createId("evd");
}

export function jobId(): string {
  return createId("job");
}

export function linkId(): string {
  return createId("lnk");
}

export function agentRunId(): string {
  return createId("run");
}
