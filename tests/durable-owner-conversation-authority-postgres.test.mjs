import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';

// Native PostgreSQL acceptance: the owner must be able to delete the original
// grant-bearing chat without losing the right to create another conversation.
test('durable owner creation authority survives deletion without granting self-tools', {timeout:120000}, async()=>{
  const bin=process.env.KATIE_TEST_PG_BIN ||
    ['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin']
      .find(path=>existsSync(join(path,'initdb')));
  assert.ok(bin,'Native PostgreSQL initdb/pg_ctl required for authorization acceptance');
  const dir=mkdtempSync(join(tmpdir(),'katie-owner-auth-pg-'));
  const data=join(dir,'data'),port=55681;
  let started=false;
  const clients=[];
  const run=(cmd,args)=>{
    const result=spawnSync(join(bin,cmd),args,{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,(result.stderr||result.error?.message||'')+
      (existsSync(join(dir,'log'))?readFileSync(join(dir,'log'),'utf8'):''));
  };
  const connect=async()=>{
    const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});
    await client.connect();clients.push(client);return client;
  };
  try {
    run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
    run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',
      "-h 127.0.0.1 -k '' -p "+port,'-w','start']);
    started=true;
    const admin=await connect();
    await admin.query(String.raw`
CREATE ROLE service_role BYPASSRLS;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean NOT NULL DEFAULT false);
CREATE TABLE public.actors(id uuid PRIMARY KEY,name text NOT NULL,actor_kind text DEFAULT 'standard');
CREATE TABLE public.chats(id uuid PRIMARY KEY,actor_id uuid REFERENCES public.actors(id) ON DELETE CASCADE,
  title text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX chats_id_actor_id_auth_fixture ON public.chats(id,actor_id);
CREATE TABLE public.managed_agents(id uuid PRIMARY KEY,actor_id uuid REFERENCES public.actors(id));
CREATE TABLE public.standalone_guest_workspaces(owner_id uuid PRIMARY KEY,actor_id uuid UNIQUE NOT NULL);
CREATE TABLE public.standalone_owner_bindings(
  owner_id uuid NOT NULL,actor_id uuid NOT NULL,chat_id uuid NOT NULL,
  revoked_at timestamptz,PRIMARY KEY(owner_id,actor_id,chat_id));
CREATE TABLE public.self_tool_owner_grants(
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,actor_id,chat_id),
  FOREIGN KEY(chat_id,actor_id) REFERENCES public.chats(id,actor_id) ON DELETE CASCADE);
ALTER TABLE public.self_tool_owner_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.self_tool_owner_grants FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.self_tool_owner_grants TO service_role;
CREATE TABLE public.short_term_memory(
  actor_id uuid,chat_id uuid REFERENCES public.chats(id) ON DELETE CASCADE,
  content jsonb,PRIMARY KEY(actor_id,chat_id));
CREATE TABLE public.intermediate_memory(
  actor_id uuid,chat_id uuid REFERENCES public.chats(id) ON DELETE CASCADE,
  content jsonb,PRIMARY KEY(actor_id,chat_id));
CREATE FUNCTION public.standalone_verify_scope(p_owner uuid,p_actor uuid,p_chat uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $body$
 SELECT EXISTS(SELECT 1 FROM standalone_owner_bindings b JOIN chats c ON c.id=b.chat_id
 WHERE b.owner_id=p_owner AND b.actor_id=p_actor AND b.chat_id=p_chat
 AND b.revoked_at IS NULL AND c.actor_id=p_actor)
$body$;
CREATE FUNCTION public.standalone_bind_scope(p_owner uuid,p_actor uuid,p_chat uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $body$
BEGIN
 IF EXISTS(SELECT 1 FROM standalone_owner_bindings WHERE chat_id=p_chat)
 THEN RAISE EXCEPTION 'STANDALONE_SCOPE_REVOKED'; END IF;
 INSERT INTO standalone_owner_bindings(owner_id,actor_id,chat_id) VALUES(p_owner,p_actor,p_chat);
 RETURN TRUE;
END $body$;
CREATE FUNCTION public.revoke_chat_scope_fixture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $body$
BEGIN
 UPDATE standalone_owner_bindings SET revoked_at=now()
 WHERE chat_id=OLD.id AND revoked_at IS NULL;
 RETURN OLD;
END $body$;
CREATE TRIGGER revoke_chat_scope_fixture BEFORE DELETE ON public.chats
FOR EACH ROW EXECUTE FUNCTION public.revoke_chat_scope_fixture();
GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
`);
    const owner=randomUUID(),outsider=randomUUID(),guest=randomUUID();
    const actor=randomUUID(),otherActor=randomUUID(),guestActor=randomUUID();
    const managed=randomUUID(),executive=randomUUID(),anchor=randomUUID();
    await admin.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,false),($2,true)',[owner,guest]);
    for(const [id,kind] of [[actor,'standard'],[otherActor,'standard'],[guestActor,'standard'],[managed,'standard'],[executive,'executive']])
      await admin.query('INSERT INTO actors(id,name,actor_kind) VALUES($1,$2,$3)',[id,'fixture '+kind,kind]);
    await admin.query('INSERT INTO managed_agents(id,actor_id) VALUES($1,$2)',[randomUUID(),managed]);
    await admin.query('INSERT INTO standalone_guest_workspaces(owner_id,actor_id) VALUES($1,$2)',[guest,guestActor]);
    await admin.query("INSERT INTO chats(id,actor_id,title) VALUES($1,$2,'Original authorization anchor')",[anchor,actor]);
    await admin.query('INSERT INTO standalone_owner_bindings(owner_id,actor_id,chat_id) VALUES($1,$2,$3)',[owner,actor,anchor]);
    await admin.query('INSERT INTO self_tool_owner_grants(owner_id,actor_id,chat_id) VALUES($1,$2,$3)',[owner,actor,anchor]);

    const migration=readFileSync(new URL('../supabase/migrations/20261120140000_durable_owner_conversation_authority.sql',import.meta.url),'utf8');
    await admin.query(migration);
    const count=async(sql,params=[])=>Number((await admin.query(sql,params)).rows[0].count);
    assert.equal(await count('SELECT count(*) FROM standalone_owner_conversation_authority'),1,
      'Only an independently verified live grant can bootstrap owner authority');
    await admin.query('DELETE FROM chats WHERE id=$1',[anchor]);
    assert.equal(await count('SELECT count(*) FROM self_tool_owner_grants'),0,
      'Deleting a chat must revoke its chat-scoped tool grant');
    assert.equal(await count('SELECT count(*) FROM standalone_owner_conversation_authority'),1,
      'Deleting the anchor must not revoke permanent-owner creation authority');

    const service=await connect();
    await service.query('SET ROLE service_role');
    const create=(u,a,c,title='New conversation')=>service.query(
      'SELECT public.standalone_create_conversation($1::uuid,$2::uuid,$3::uuid,$4::text) AS created',
      [u,a,c,title]);
    const fresh=randomUUID();
    assert.equal((await create(owner,actor,fresh)).rows[0].created.id,fresh,
      'Verified owner must be able to create after original grant-bearing chat deletion');
    assert.equal(await count('SELECT count(*) FROM self_tool_owner_grants'),0,
      'Creating a conversation must not silently grant self-tool privileges');
    assert.equal(await count('SELECT count(*) FROM short_term_memory WHERE chat_id=$1',[fresh]),1);
    assert.equal(await count('SELECT count(*) FROM intermediate_memory WHERE chat_id=$1',[fresh]),1);
    const second=randomUUID();
    assert.equal((await create(owner,otherActor,second)).rows[0].created.id,second,
      'Pre-existing non-guest standard actors remain available to the sole owner');
    await assert.rejects(create(guest,actor,randomUUID()),/STANDALONE_ACTOR_ACCESS_DENIED/);
    await assert.rejects(create(owner,guestActor,randomUUID()),/STANDALONE_ACTOR_ACCESS_DENIED/);
    await assert.rejects(create(owner,managed,randomUUID()),/STANDALONE_SCOPE_INVALID/);
    await assert.rejects(create(owner,executive,randomUUID()),/STANDALONE_SCOPE_INVALID/);
    await assert.rejects(create(owner,actor,anchor),/STANDALONE_SCOPE_REVOKED/,
      'A deleted chat UUID cannot be re-enrolled, even with valid owner authority');

    await admin.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,false)',[outsider]);
    await assert.rejects(create(owner,actor,randomUUID()),/STANDALONE_ACTOR_ACCESS_DENIED/,
      'An additional permanent account disables sole-owner blanket enrollment');
    await admin.query('DELETE FROM auth.users WHERE id=$1',[outsider]);
    await admin.query('UPDATE standalone_owner_conversation_authority SET revoked_at=now() WHERE owner_id=$1',[owner]);
    await assert.rejects(create(owner,actor,randomUUID()),/STANDALONE_ACTOR_ACCESS_DENIED/,
      'Explicit owner-creation revocation must be enforced');
    await service.query('SET ROLE authenticated');
    await assert.rejects(service.query(
      'INSERT INTO standalone_owner_conversation_authority(owner_id) VALUES($1)',[guest]),/permission denied/);
    await assert.rejects(create(owner,actor,randomUUID()),/permission denied/,
      'A browser authenticated role must never invoke privileged creation RPC');
    console.log('OWNER_CHAT_CREATION_SURVIVES_ANCHOR_DELETION_SECURITY_PASS');
  } finally {
    await Promise.allSettled(clients.map(client=>client.end()));
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(dir,{recursive:true,force:true});
  }
});
