#!/usr/bin/env node
/**
 * Simple SQL migration runner.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node packages/db/dist/migrate.js
 *   pnpm --filter @codesteward/db run migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, closePool, getDatabaseUrl } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // dist/migrate.js → ../migrations ; src via tsx → ../migrations
  return join(__dirname, "..", "migrations");
}

export async function migrate(connectionString?: string): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const url = connectionString ?? getDatabaseUrl();
  if (!url) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const pool = createPool({ connectionString: url });
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dir = migrationsDir();
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const exists = await pool.query(
        `SELECT 1 FROM schema_migrations WHERE id = $1`,
        [id],
      );
      if (exists.rowCount && exists.rowCount > 0) {
        skipped.push(id);
        continue;
      }

      const sql = await readFile(join(dir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [id],
        );
        await client.query("COMMIT");
        applied.push(id);
        console.log(`[db] applied migration ${id}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  return { applied, skipped };
}

async function main() {
  const result = await migrate();
  console.log(
    `[db] migrate done applied=${result.applied.length} skipped=${result.skipped.length}`,
  );
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.js") ||
    process.argv[1].endsWith("migrate.ts"));

if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[db] migrate failed", err);
      process.exit(1);
    })
    .finally(() => {
      void closePool();
    });
}
