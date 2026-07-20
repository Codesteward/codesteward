/**
 * Lightweight preference embeddings for noise filtering.
 * Uses a deterministic bag-of-tokens vector (no external API) so offline / air-gapped
 * installs still get cosine preference filtering after enough 👍/👎.
 */

export const EMBED_DIMS = 64;
export const EMBED_MODEL = "bow-v1";

/** Deterministic bag-of-words embedding (L2-normalized). */
export function textEmbedding(text: string, dims = EMBED_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9_./+-]+/).filter(Boolean);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = (h >>> 0) % dims;
    vec[idx]! += 1;
    // bigrams boost
    if (token.length > 3) {
      const idx2 = ((h >>> 8) >>> 0) % dims;
      vec[idx2]! += 0.5;
    }
  }
  return l2Normalize(vec);
}

export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const n = Math.sqrt(sum) || 1;
  return vec.map((v) => v / n);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface PreferencePrototype {
  polarity: "positive" | "negative";
  embedding: number[];
  fingerprint?: string;
  subjectId: string;
}

/**
 * Match a candidate text against stored preference prototypes.
 * Returns suppress=true when nearest negative beats positive by margin.
 */
export function matchPreference(
  text: string,
  prototypes: PreferencePrototype[],
  opts: { suppressThreshold?: number; margin?: number } = {},
): { suppress: boolean; boost: boolean; score: number; nearest?: PreferencePrototype } {
  if (!prototypes.length) {
    return { suppress: false, boost: false, score: 0 };
  }
  const suppressThreshold = opts.suppressThreshold ?? 0.55;
  const margin = opts.margin ?? 0.08;
  const query = textEmbedding(text);
  let bestPos = -1;
  let bestNeg = -1;
  let nearest: PreferencePrototype | undefined;
  let nearestScore = -2;
  for (const p of prototypes) {
    const s = cosineSimilarity(query, p.embedding);
    if (s > nearestScore) {
      nearestScore = s;
      nearest = p;
    }
    if (p.polarity === "positive") bestPos = Math.max(bestPos, s);
    else bestNeg = Math.max(bestNeg, s);
  }
  const suppress =
    bestNeg >= suppressThreshold && bestNeg >= bestPos + margin;
  const boost =
    bestPos >= suppressThreshold && bestPos >= bestNeg + margin;
  return {
    suppress,
    boost,
    score: nearestScore,
    nearest,
  };
}

export function findingEmbedText(f: {
  title?: string;
  body?: string;
  category?: string;
  path?: string;
}): string {
  return [f.title, f.category, f.path, f.body?.slice(0, 400)].filter(Boolean).join("\n");
}
