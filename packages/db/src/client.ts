import pg from "pg";

const { Pool } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

let sharedPool: DbPool | undefined;

export function getDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : undefined;
}

export function isDatabaseEnabled(): boolean {
  return Boolean(getDatabaseUrl());
}

export interface CreatePoolOptions {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/** Create a new pool (or return the process-wide shared pool when no custom URL). */
export function createPool(opts: CreatePoolOptions = {}): DbPool {
  const connectionString = opts.connectionString ?? getDatabaseUrl();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — cannot create Postgres pool. Use file-backed stores or set DATABASE_URL.",
    );
  }

  if (!opts.connectionString && sharedPool) {
    return sharedPool;
  }

  const pool = new Pool({
    connectionString,
    max: opts.max ?? Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
  });

  pool.on("error", (err) => {
    console.error("[db] idle client error", err);
  });

  if (!opts.connectionString) {
    sharedPool = pool;
  }
  return pool;
}

/** Process-wide shared pool (lazy). */
export function getPool(): DbPool {
  if (!sharedPool) {
    sharedPool = createPool();
  }
  return sharedPool;
}

export async function closePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

export async function withClient<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

/** Query helper that accepts Pool or PoolClient. */
export type Queryable = Pick<DbPool, "query">;
