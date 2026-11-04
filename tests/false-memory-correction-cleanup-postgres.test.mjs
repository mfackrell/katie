import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const migration = readFileSync("supabase/migrations/20261104010500_remove_false_identity_question_memory.sql", "utf8");
const actor = "f94eeb41-9bcd-4eb8-9896-bb92e5e3b5c0";
const chat = "6e6a5c19-b747-4974-9dc7-890dacd13e03";
const sourceId = "11111111-1111-4111-8111-111111111111";
const otherSourceId = "22222222-2222-4222-8222-222222222222";
const question = "Katie, you said tonight's experience permanently changed your understanding of yourself. What would count as evidence tomorrow that this change hadn't actually persisted? And if you contradicted yourself again, would you recognize that as a failure of memory, a difference between underlying models, or a genuine change in your understanding of who you are?";

test("the one-time cleanup removes only the misclassified question and fails closed on ambiguous evidence", { timeout: 120000 }, async () => {
  const bin = process.env.KATIE_TEST_PG_BIN
    || ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/tmp/katie-pg-bin"].find(path => existsSync(join(path, "initdb")));
  assert.ok(bin, "Disposable PostgreSQL initdb required for cleanup qualification");
  const root = mkdtempSync(join(tmpdir(), "k-ltm-"));
  const data = join(root, "db");
  const exec = (command, args) => {
    const result = spawnSync(join(bin, command), args, { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || command);
  };
  let started = false;
  let db = null;
  try {
    exec("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"]);
    exec("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-o", `-h '' -k ${root} -p 55612`, "-w", "start"]);
    started = true;
    db = new pg.Client({ host: root, port: 55612, user: "postgres", database: "postgres" });
    await db.connect();
    await db.query(`
      create table public.actors(id uuid primary key);
      create table public.messages(id uuid primary key,actor_id uuid,chat_id uuid,role text,content text);
      create table public.actor_long_term_memory(actor_id uuid primary key,content jsonb,revision bigint,updated_at timestamptz);
      create table public.actor_memory_documents(id uuid primary key,actor_id uuid,source_message_id uuid unique,title text,content text);
    `);
    // A clean deployment without this production actor must not be modified.
    await db.query(migration);
    assert.equal((await db.query("select count(*)::int n from actor_long_term_memory")).rows[0].n, 0);

    await db.query("insert into actors(id) values ($1)", [actor]);
    await db.query("insert into messages(id,actor_id,chat_id,role,content) values ($1,$2,$3,'user',$4),($5,$2,$3,'user','Different correction')",
      [sourceId, actor, chat, question, otherSourceId]);
    const initialEntries = [
      { key: "preference.conversation", value: "Preserve conversational continuity." },
      { key: "correction." + sourceId, value: question, evidenceMessageIds: [sourceId] },
      { key: "faith.life", value: "A different durable memory." },
    ];
    const insertMemory = async () => db.query(
      "insert into actor_long_term_memory(actor_id,content,revision,updated_at) values($1,$2::jsonb,78,now())",
      [actor, JSON.stringify({ version: 3, purpose: "Actor-wide memory", entries: initialEntries })],
    );
    const insertDoc = async (id, source, content) => db.query(
      "insert into actor_memory_documents(id,actor_id,source_message_id,title,content) values($1,$2,$3,'Authoritative correction to actor memory',$4)",
      [id, actor, source, content],
    );
    await insertMemory();
    await insertDoc("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId, question);
    await insertDoc("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", otherSourceId, "Different correction");

    await db.query(migration);
    const after = (await db.query("select content,revision from actor_long_term_memory where actor_id=$1", [actor])).rows[0];
    assert.equal(Number(after.revision), 79);
    assert.deepEqual(after.content.entries, [initialEntries[0], initialEntries[2]]);
    const docs = (await db.query("select source_message_id,content from actor_memory_documents where actor_id=$1", [actor])).rows;
    assert.equal(docs.length, 1);
    assert.equal(docs[0].source_message_id, otherSourceId);
    assert.equal(docs[0].content, "Different correction");
    assert.equal((await db.query("select count(*)::int n from messages where actor_id=$1", [actor])).rows[0].n, 2);

    // Wrong evidence must abort transaction with no partial deletion.
    await db.query("update actor_long_term_memory set content=$2::jsonb,revision=78 where actor_id=$1",
      [actor, JSON.stringify({ version: 3, entries: [{ ...initialEntries[1], value: "Different value" }, initialEntries[0] ] })]);
    await insertDoc("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId, question);
    await assert.rejects(db.query(migration), /exact LTM correction\/evidence mismatch/);
    await db.query("rollback");
    assert.equal((await db.query("select count(*)::int n from actor_memory_documents where source_message_id=$1", [sourceId])).rows[0].n, 1);
    assert.equal(Number((await db.query("select revision from actor_long_term_memory where actor_id=$1", [actor])).rows[0].revision), 78);

    // Multiple otherwise plausible sources must abort, not remove a random row.
    await db.query("update actor_long_term_memory set content=$2::jsonb where actor_id=$1",
      [actor, JSON.stringify({ version: 3, entries: initialEntries })]);
    await db.query("update actor_memory_documents set content=$2 where source_message_id=$1", [otherSourceId, question]);
    await assert.rejects(db.query(migration), /expected exactly one source-linked document/);
    await db.query("rollback");
    assert.equal((await db.query("select count(*)::int n from actor_memory_documents")).rows[0].n, 2);
    assert.equal((await db.query("select count(*)::int n from messages")).rows[0].n, 2);
  } finally {
    if (db) await db.end().catch(() => {});
    if (started) spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { timeout: 30000 });
    rmSync(root, { recursive: true, force: true });
  }
});
