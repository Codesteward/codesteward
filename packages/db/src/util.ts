import { createId } from "@codesteward/core";

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (value == null) return new Date().toISOString();
  return String(value);
}

export function toIsoOpt(value: unknown): string | undefined {
  if (value == null) return undefined;
  return toIso(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return [];
}

export function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => Number(v));
}

export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function newCheckpointId(): string {
  return createId("chk");
}

export function newReactionId(): string {
  return createId("rxn");
}

export function newMemoryId(): string {
  return createId("mem");
}

export function newEmbeddingId(): string {
  return createId("emb");
}
