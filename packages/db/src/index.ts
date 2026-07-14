export {
  createPool,
  getPool,
  closePool,
  getDatabaseUrl,
  isDatabaseEnabled,
  withClient,
  withTransaction,
  type DbPool,
  type DbClient,
  type Queryable,
  type CreatePoolOptions,
} from "./client.js";

export { migrate } from "./migrate.js";

export * from "./types.js";
export * from "./repositories/index.js";

import type { DbPool } from "./client.js";
import { createPool, getPool, isDatabaseEnabled } from "./client.js";
import { SessionsRepository } from "./repositories/sessions.js";
import { FindingsRepository } from "./repositories/findings.js";
import { ConfigsRepository } from "./repositories/configs.js";
import { LinksRepository } from "./repositories/links.js";
import { JobsRepository } from "./repositories/jobs.js";
import { LearningRepository } from "./repositories/learning.js";
import { CheckpointsRepository } from "./repositories/checkpoints.js";
import { UsersRepository } from "./repositories/users.js";
import { ConnectorsRepository } from "./repositories/connectors.js";
import { TenancyRepository } from "./repositories/tenancy.js";

/** Bundle of all repositories bound to one pool. */
export interface StewardDb {
  pool: DbPool;
  sessions: SessionsRepository;
  findings: FindingsRepository;
  configs: ConfigsRepository;
  links: LinksRepository;
  jobs: JobsRepository;
  learning: LearningRepository;
  checkpoints: CheckpointsRepository;
  users: UsersRepository;
  connectors: ConnectorsRepository;
  tenancy: TenancyRepository;
}

export function createStewardDb(pool?: DbPool): StewardDb {
  const p = pool ?? getPool();
  return {
    pool: p,
    sessions: new SessionsRepository(p),
    findings: new FindingsRepository(p),
    configs: new ConfigsRepository(p),
    links: new LinksRepository(p),
    jobs: new JobsRepository(p),
    learning: new LearningRepository(p),
    checkpoints: new CheckpointsRepository(p),
    users: new UsersRepository(p),
    connectors: new ConnectorsRepository(p),
    tenancy: new TenancyRepository(p),
  };
}

/** Create db when DATABASE_URL is set; otherwise return undefined. */
export function tryCreateStewardDb(): StewardDb | undefined {
  if (!isDatabaseEnabled()) return undefined;
  return createStewardDb(createPool());
}
