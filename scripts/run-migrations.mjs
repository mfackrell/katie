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

for (const file of files) {
  const absolutePath = join(migrationsDir, file);
  const contents = readFileSync(absolutePath, 'utf8');
  const checksum = createHash('sha256').update(contents).digest('hex');

  const statusQuery = `SELECT checksum FROM schema_migrations WHERE filename = '${file.replace(/'/g, "''")}';`;
  const status = spawnSync(
    'psql',
    [databaseUrl, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', statusQuery],
    { encoding: 'utf8' }
  );

  if (status.status !== 0) {
    process.stderr.write(status.stderr ?? '');
    process.exit(status.status ?? 1);
  }

  const existingChecksum = (status.stdout ?? '').trim();
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
