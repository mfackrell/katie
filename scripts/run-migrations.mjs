#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations.');
  process.exit(1);
}

let files;
try {
  files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
} catch (error) {
  console.error(`Unable to read migrations directory: ${migrationsDir}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (files.length === 0) {
  console.log('No migration files found.');
  process.exit(0);
}

const baseSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

const initResult = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', baseSql], {
  stdio: 'inherit'
});

if (initResult.error) {
  console.error('Failed to run psql. Ensure psql is installed and available in PATH.');
  console.error(initResult.error.message);
  process.exit(1);
}

if (initResult.status !== 0) {
  process.exit(initResult.status ?? 1);
}

// Read the complete ledger once. The prior runner created a fresh Supavisor
// authentication session for EVERY applied migration (even no-op releases).
// This reduces a no-op release from hundreds of connections to two.
const ledgerQuery = "SELECT coalesce(json_object_agg(filename,checksum)::text,'{}') FROM schema_migrations;";
let ledger;
for (let attempt = 0; attempt < 3; attempt++) {
  const read = spawnSync('psql', [databaseUrl, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', ledgerQuery],
    { encoding: 'utf8', timeout: 30000 });
  if (read.status === 0) { ledger = JSON.parse(read.stdout.trim()); break; }
  const transient = /authentication did not complete|authentication timeout|connection timed out|could not connect|connection terminated/i.test(read.stderr ?? '');
  if (!transient || attempt === 2) {
    process.stderr.write(read.stderr ?? 'Migration ledger read failed');
    process.exit(read.status ?? 1);
  }
  console.warn('Transient database authentication failure reading migration ledger; retrying read-only connection.');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1));
}
if (!ledger || typeof ledger !== 'object') throw Error('Migration ledger unavailable');
for (const file of files) {
  const absolutePath = join(migrationsDir, file);
  const contents = readFileSync(absolutePath, 'utf8');
  const checksum = createHash('sha256').update(contents).digest('hex');
  const existingChecksum = ledger[file];
  if (existingChecksum) {
    if (existingChecksum !== checksum) {
      console.error(`Checksum mismatch for already-applied migration: ${file}`);
      process.exit(1);
    }
    console.log(`Skipping already-applied migration: ${file}`);
    continue;
  }

  console.log(`Applying migration: ${file}`);
  const apply = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', absolutePath], {
    stdio: 'inherit'
  });

  if (apply.status !== 0) {
    process.exit(apply.status ?? 1);
  }

  const recordSql = `
INSERT INTO schema_migrations (filename, checksum)
VALUES ('${file.replace(/'/g, "''")}', '${checksum}')
ON CONFLICT (filename) DO NOTHING;
`;

  const record = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', recordSql], {
    stdio: 'inherit'
  });

  if (record.status !== 0) {
    process.exit(record.status ?? 1);
  }
}

console.log('Migration run complete.');
