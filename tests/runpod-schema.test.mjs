import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const migration = readFileSync('supabase/migrations/202610130001_video_analysis_jobs.sql', 'utf8');
const contract = JSON.parse(readFileSync('tests/fixtures/runpod-deployed-schema.json', 'utf8'));
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const normalize = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
const columns = `SELECT jsonb_agg(to_jsonb(c) ORDER BY ordinal_position) FROM (SELECT column_name,data_type,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema='public' AND table_name='video_analysis_jobs') c`;
const indexes = `SELECT jsonb_agg(to_jsonb(i) ORDER BY indexname) FROM (SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='video_analysis_jobs') i`;
const constraints = `SELECT jsonb_agg(to_jsonb(c) ORDER BY name) FROM (SELECT conname AS name,lower(regexp_replace(pg_get_constraintdef(oid),'\\s+',' ','g')) AS definition FROM pg_constraint WHERE conrelid='public.video_analysis_jobs'::regclass) c`;
const expectedColumns = contract.columns.map((c, i) => ({ ...c, ordinal_position: i + 1 }));
const expectedIndexes = [...contract.indexes].sort((a,b) => a.indexname.localeCompare(b.indexname));
const expectedConstraints = contract.constraints.map(c => ({ name: c.name, definition: normalize(c.definition) }));

// Real PostgreSQL standalone backend: no sockets, network, DATABASE_URL or mocks.
// -j reads complete SQL blocks separated by blank lines, including DO bodies.
test('standalone disposable Postgres reproduces schema, permissions, constraints and inert reruns', () => {
  const bin = process.env.KATIE_TEST_PG_BIN ?? '/usr/lib/postgresql/16/bin';
  assert.ok(existsSync(join(bin, 'initdb')), 'Install local PostgreSQL server binaries or set KATIE_TEST_PG_BIN; do not skip database verification.');
  const root = mkdtempSync(join(tmpdir(), 'katie-runpod-pg-'));
  const data = join(root, 'data');
  const run = (tool, args, input) => {
    let fd;
    if (input !== undefined) { writeFileSync(join(root, 'verify.sql'), input); fd = openSync(join(root, 'verify.sql'), 'r'); }
    let result;
    try { result = spawnSync(join(bin, tool), args, { stdio: [fd ?? 'ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); }
    finally { if (fd !== undefined) closeSync(fd); }
    assert.equal(result.status, 0, `${tool}: ${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stderr, /(?:ERROR|FATAL|PANIC):/, result.stderr);
    return result.stdout;
  };
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    const blocks = [
      `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
       GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;
       CREATE TABLE public.actors(id uuid PRIMARY KEY); CREATE TABLE public.chats(id uuid PRIMARY KEY);`,
      migration,
      `DO $test$ DECLARE actual jsonb; role_name text; privilege_name text; BEGIN
        SELECT (${columns}) INTO actual;
        IF actual IS DISTINCT FROM ${literal(JSON.stringify(expectedColumns))}::jsonb THEN RAISE EXCEPTION 'Column drift: %', actual; END IF;
        SELECT (${indexes}) INTO actual;
        IF actual IS DISTINCT FROM ${literal(JSON.stringify(expectedIndexes))}::jsonb THEN RAISE EXCEPTION 'Index drift: %', actual; END IF;
        SELECT (${constraints}) INTO actual;
        IF actual IS DISTINCT FROM ${literal(JSON.stringify(expectedConstraints))}::jsonb THEN RAISE EXCEPTION 'Constraint drift: %', actual; END IF;
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.video_analysis_jobs'::regclass) THEN RAISE EXCEPTION 'RLS disabled'; END IF;
        IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_analysis_jobs') THEN RAISE EXCEPTION 'Unexpected policy'; END IF;
        FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
          IF NOT has_table_privilege('service_role','public.video_analysis_jobs',privilege_name) THEN RAISE EXCEPTION 'Missing service privilege %',privilege_name; END IF;
          FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
            IF has_table_privilege(role_name,'public.video_analysis_jobs',privilege_name) THEN RAISE EXCEPTION 'Unexpected client privilege % %',role_name,privilege_name; END IF;
          END LOOP;
        END LOOP;
       END $test$;`,
      // Explicitly switch roles to exercise access, rather than relying on superuser queries.
      `SET ROLE anon; DO $test$ BEGIN
         BEGIN PERFORM * FROM public.video_analysis_jobs; RAISE EXCEPTION 'anon read succeeded'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
         BEGIN INSERT INTO public.video_analysis_jobs DEFAULT VALUES; RAISE EXCEPTION 'anon insert succeeded'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
       END $test$; RESET ROLE;
       SET ROLE authenticated; DO $test$ BEGIN
         BEGIN PERFORM * FROM public.video_analysis_jobs; RAISE EXCEPTION 'authenticated read succeeded'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
         BEGIN INSERT INTO public.video_analysis_jobs DEFAULT VALUES; RAISE EXCEPTION 'authenticated insert succeeded'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
       END $test$; RESET ROLE;`,
      `SET ROLE service_role;
       DO $test$ DECLARE job public.video_analysis_jobs; state text; path text; col text; violated text; BEGIN
         INSERT INTO public.video_analysis_jobs DEFAULT VALUES RETURNING * INTO job;
         IF job.status <> 'pending' OR job.fallback_attempts <> 0 OR job.model <> 'Qwen/Qwen3-VL-8B-Instruct' OR job.endpoint_id <> 'yafwsm98e8m9lv' OR job.id IS NULL OR job.submitted_at IS NULL OR job.updated_at IS NULL THEN RAISE EXCEPTION 'Default drift'; END IF;
         FOREACH state IN ARRAY ARRAY['pending','queued','in_progress','completed','failed','cancelled','timed_out','expired'] LOOP
           UPDATE public.video_analysis_jobs SET status=state WHERE id=job.id;
         END LOOP;
         BEGIN INSERT INTO public.video_analysis_jobs(status) VALUES ('rejected'); RAISE EXCEPTION 'Invalid status accepted';
           EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME; IF violated <> 'video_analysis_jobs_status_check' THEN RAISE; END IF; END;
         BEGIN INSERT INTO public.video_analysis_jobs(analysis_text) VALUES (repeat('x',250001)); RAISE EXCEPTION 'Oversized content accepted';
           EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME; IF violated <> 'video_analysis_jobs_content_limit' THEN RAISE; END IF; END;
         BEGIN INSERT INTO public.video_analysis_jobs(runpod_job_id) VALUES (repeat('x',151)); RAISE EXCEPTION 'Oversized ID accepted';
           EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME; IF violated <> 'video_analysis_jobs_id_limit' THEN RAISE; END IF; END;
         FOREACH path IN ARRAY ARRAY['https://private.invalid/source','chats/source?token=secret'] LOOP
           BEGIN INSERT INTO public.video_analysis_jobs(attachment_path) VALUES (path); RAISE EXCEPTION 'Signed source accepted';
             EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME; IF violated <> 'video_analysis_jobs_no_signed_source' THEN RAISE; END IF; END;
         END LOOP;
         INSERT INTO public.video_analysis_jobs(runpod_job_id,attachment_path,analysis_text) VALUES ('provider-123','chats/private.source',repeat('x',250000));
         BEGIN INSERT INTO public.video_analysis_jobs(runpod_job_id) VALUES ('provider-123'); RAISE EXCEPTION 'Duplicate provider ID accepted';
           EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME; IF violated <> 'video_analysis_jobs_runpod_job_id_key' THEN RAISE; END IF; END;
         FOREACH col IN ARRAY ARRAY['actor_id','chat_id','target_chat_id'] LOOP
           BEGIN EXECUTE format('INSERT INTO public.video_analysis_jobs(%I) VALUES (%L)',col,'12345678-1234-1234-1234-123456789abc'); RAISE EXCEPTION 'Missing FK accepted';
             EXCEPTION WHEN foreign_key_violation THEN GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME; IF violated <> 'video_analysis_jobs_' || col || '_fkey' THEN RAISE; END IF; END;
         END LOOP;
       END $test$; RESET ROLE;`,
      `INSERT INTO public.actors VALUES ('12345678-1234-1234-1234-123456789abc');
       INSERT INTO public.chats VALUES ('12345678-1234-1234-1234-123456789abc');
       INSERT INTO public.video_analysis_jobs(actor_id,chat_id,target_chat_id) VALUES ('12345678-1234-1234-1234-123456789abc','12345678-1234-1234-1234-123456789abc','12345678-1234-1234-1234-123456789abc');
       DELETE FROM public.actors; DELETE FROM public.chats;
       DO $test$ BEGIN IF EXISTS(SELECT 1 FROM public.video_analysis_jobs WHERE actor_id IS NOT NULL OR chat_id IS NOT NULL OR target_chat_id IS NOT NULL) THEN RAISE EXCEPTION 'SET NULL drift'; END IF; END $test$;
       CREATE TEMP TABLE before_rows AS SELECT * FROM public.video_analysis_jobs;
       CREATE TEMP TABLE before_catalog AS SELECT (${columns}) AS cols, (${indexes}) AS idx, (${constraints}) AS cons;
       CREATE TEMP TABLE before_acl AS SELECT relacl,relrowsecurity FROM pg_class WHERE oid='public.video_analysis_jobs'::regclass;`,
      migration, migration,
      `DO $test$ BEGIN
         IF EXISTS((SELECT * FROM public.video_analysis_jobs EXCEPT SELECT * FROM before_rows) UNION ALL (SELECT * FROM before_rows EXCEPT SELECT * FROM public.video_analysis_jobs)) THEN RAISE EXCEPTION 'Rerun modified rows'; END IF;
         IF EXISTS(SELECT 1 FROM before_catalog WHERE cols IS DISTINCT FROM (${columns}) OR idx IS DISTINCT FROM (${indexes}) OR cons IS DISTINCT FROM (${constraints})) THEN RAISE EXCEPTION 'Rerun catalog drift'; END IF;
         IF EXISTS(SELECT 1 FROM before_acl b,pg_class c WHERE c.oid='public.video_analysis_jobs'::regclass AND (b.relacl IS DISTINCT FROM c.relacl OR b.relrowsecurity IS DISTINCT FROM c.relrowsecurity)) THEN RAISE EXCEPTION 'Rerun security drift'; END IF;
       END $test$;
       ALTER TABLE public.video_analysis_jobs ADD COLUMN existing_marker text;`,
      migration,
      `DO $test$ BEGIN IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='video_analysis_jobs' AND column_name='existing_marker') THEN RAISE EXCEPTION 'Existing divergent table changed'; END IF; END $test$;
       SELECT 'KATIE_RUNPOD_CONTRACT_OK';`,
    ];
    // Remove interior empty lines: -j treats each blank line as a complete command batch.
    const input = blocks.map(b => b.replace(/\n\s*\n/g, '\n').trim()).join('\n\n') + '\n\n';
    const output = run('postgres', ['--single', '-j', '-D', data, 'postgres'], input);
    assert.match(output, /KATIE_RUNPOD_CONTRACT_OK/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
