import type {
  CrossRepoLink,
  Finding,
  ProgressEvent,
  ReviewJob,
  ReviewSession,
  ReviewUnit,
} from "@codesteward/core";

/** Org-level durable config (model profiles, STEWARD overrides, feature flags). */
export interface OrgSettings {
  orgId: string;
  tenantId: string;
  modelProfiles: Record<string, unknown>;
  stewardOverrides: Record<string, unknown>;
  featureFlags: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UnitCheckpoint {
  id: string;
  unitId: string;
  sessionId: string;
  stage: string;
  cursor: Record<string, unknown>;
  state: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type LearningReactionKind =
  | "thumb_up"
  | "thumb_down"
  | "dismiss"
  | "fix"
  | "comment";

export interface LearningReaction {
  id: string;
  orgId: string;
  tenantId: string;
  findingId?: string;
  sessionId?: string;
  repoId?: string;
  kind: LearningReactionKind | string;
  userId?: string;
  comment?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LearningMemory {
  id: string;
  orgId: string;
  tenantId: string;
  repoId?: string;
  kind: string;
  title?: string;
  body: string;
  source?: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LearningEmbeddingMeta {
  id: string;
  orgId: string;
  tenantId: string;
  repoId?: string;
  subjectType: string;
  subjectId: string;
  model: string;
  dims: number;
  /** Portable float vector (pgvector optional later). */
  embedding: number[];
  contentHash?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "dead";

export interface JobRecord {
  id: string;
  sessionId: string;
  status: JobStatus;
  payload: ReviewJob;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type OutboxStatus = "pending" | "published" | "failed";

export interface OutboxEvent {
  id: number;
  topic: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  availableAt: string;
  publishedAt?: string;
  lastError?: string;
  createdAt: string;
}

export type ScmDeliveryStatus =
  | "received"
  | "processed"
  | "ignored"
  | "failed";

export interface ScmDeliveryLog {
  deliveryId: string;
  provider: string;
  eventType?: string;
  orgId?: string;
  repoId?: string;
  payloadHash?: string;
  status: ScmDeliveryStatus;
  sessionId?: string;
  jobId?: string;
  error?: string;
  receivedAt: string;
  processedAt?: string;
}

export interface AgentFailureLog {
  id: number;
  sessionId?: string;
  unitId?: string;
  orgId?: string;
  repoId?: string;
  agentRole?: string;
  errorClass?: string;
  message: string;
  stack?: string;
  retriable: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type {
  CrossRepoLink,
  Finding,
  ProgressEvent,
  ReviewJob,
  ReviewSession,
  ReviewUnit,
};


// ---------------------------------------------------------------------------
// Auth + connectors
// ---------------------------------------------------------------------------

export type UserRole = "admin" | "reviewer" | "viewer";

/** Install-wide operator (not the same as tenant org admin). */
export type PlatformAdminFlag = boolean;

export interface StewardUser {
  id: string;
  email: string;
  passwordHash: string;
  displayName?: string;
  role: UserRole;
  orgId: string;
  /** Install-wide platform operator (license, runtime knobs). Not tenant admin. */
  platformAdmin?: boolean;
  /** SCIM / directory active flag (false = deprovisioned, sessions blocked). */
  active?: boolean;
  /** IdP external id (SCIM externalId). */
  externalId?: string;
  scimMeta?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface OrgConnector {
  orgId: string;
  type: string;
  /** Secrets stored as-is for self-host; mask before API responses. */
  config: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}
