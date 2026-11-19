/**
 * Agent A database-predicate evidence: disposable native PostgreSQL.
 * Companion TypeScript regression verifies production query-builder filters;
 * this independently checks time/scope/order SQL semantics.
 * Synthetic schemas do not independently prove production RLS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';

const bin=process.env.KATIE_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
const native=existsSync(join(bin,'initdb'))&&existsSync(join(bin,'pg_ctl'));

test('Agent A native PG predecessor scope and settlement-time attribution predicates',
 {skip:native?false:'PostgreSQL binaries unavailable; CI installs native PG',timeout:90000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'katie-a-provenance-'));
  const data=join(root,'db'),port=55000+(process.pid%700);
  let started=false,db;
  const pgCommand=(name,args)=>{
    const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
    assert.equal(r.status,0,r.stderr||r.error?.message||name+' failed');
  };
  try{
    pgCommand('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
    pgCommand('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',"-h '' -k "+root+" -p "+port,'-w','start']);
    started=true;
    db=new pg.Client({host:root,port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
    await db.connect();
    await db.query([
      'create table standalone_workflows(owner_id text not null,actor_id text not null,chat_id text not null,request_id text not null,status text not null,created_at timestamptz not null,checkpoints jsonb not null default \'{}\'::jsonb,primary key(owner_id,actor_id,chat_id,request_id));',
      'create table messages(id text primary key,actor_id text not null,chat_id text not null,role text not null,model text,created_at timestamptz not null);',
      'create table chat_requests(request_id text primary key,actor_id text not null,chat_id text not null,assistant_message_id text,assistant_model text,status text not null,completed_at timestamptz);'
    ].join('\n'));
    const owner='owner-1',actor='actor-1',chat='chat-1';
    const now='2026-11-18T22:10:00.000Z';
    const audit=(model)=>JSON.stringify({'routing-delivery-audit:v1':{provider:'openai',model,classifiedIntent:'social-emotional'}});
    await db.query('insert into standalone_workflows values ($1,$2,$3,$4,$5,$6,$7)',
      [owner,actor,chat,'current','running',now,'{}']);
    await db.query('insert into standalone_workflows values ($1,$2,$3,$4,$5,$6,$7)',
      [owner,actor,chat,'prior','completed','2026-11-18T22:09:00.000Z',audit('gpt-5-mini')]);
    await db.query('insert into messages values ($1,$2,$3,$4,$5,$6)',
      ['prior-assistant',actor,chat,'assistant','gpt-5-mini','2026-11-18T22:09:30.000Z']);
    await db.query('insert into chat_requests values ($1,$2,$3,$4,$5,$6,$7)',
      ['prior',actor,chat,'prior-assistant','gpt-5-mini','completed','2026-11-18T22:09:59.000Z']);
    // App uses identical equality, less-than and descending-order predicates.
    const recent=async(a=actor,c=chat)=>(await db.query(
      'select id,role,model from messages where actor_id=$1 and chat_id=$2 and created_at<$3 order by created_at desc limit 1',
      [a,c,now])).rows[0]??null;
    const priorReceipt=async(a=actor,c=chat,id='prior-assistant')=>(await db.query(
      "select request_id,assistant_message_id,assistant_model,completed_at from chat_requests where actor_id=$1 and chat_id=$2 and assistant_message_id=$3 and status='completed'",
      [a,c,id])).rows[0]??null;
    const workflow=async(o=owner,a=actor,c=chat,request='prior')=>(await db.query(
      "select status,checkpoints from standalone_workflows where owner_id=$1 and actor_id=$2 and chat_id=$3 and request_id=$4 and status='completed'",
      [o,a,c,request])).rows[0]??null;
    assert.equal((await recent())?.id,'prior-assistant');
    assert.equal((await priorReceipt())?.assistant_model,'gpt-5-mini');
    assert.equal((await workflow())?.checkpoints?.['routing-delivery-audit:v1']?.model,'gpt-5-mini');
    assert.ok(new Date((await priorReceipt()).completed_at)<=new Date(now),'settled before criticism');
    assert.equal(await recent('different-actor'),null,'other actors excluded');
    assert.equal(await recent(actor,'different-chat'),null,'other chats excluded');
    assert.equal(await priorReceipt(actor,'different-chat'),null,'wrong-chat receipt excluded');
    assert.equal(await workflow('different-owner'),null,'wrong owner excluded');
    assert.equal(await workflow(owner,'different-actor'),null,'wrong actor excluded');
    await db.query("update chat_requests set completed_at='2026-11-18T22:10:01Z' where request_id='prior'");
    assert.ok(new Date((await priorReceipt()).completed_at)>new Date(now),
      'late completion must be rejected by app time comparison');
    await db.query("update chat_requests set completed_at='2026-11-18T22:09:59Z' where request_id='prior'");
    await db.query('insert into messages values($1,$2,$3,$4,$5,$6)',
      ['intervening-user',actor,chat,'user',null,'2026-11-18T22:09:59.500Z']);
    assert.equal((await recent())?.role,'user','intervening user is immediate predecessor');
    await db.query('insert into messages values($1,$2,$3,$4,$5,$6)',
      ['future-assistant',actor,chat,'assistant','gpt-5.4','2026-11-18T22:10:01Z']);
    assert.equal((await recent())?.id,'intervening-user',
      'newer replies must not become past feedback targets');
  }finally{
    if(db) await db.end().catch(()=>{});
    if(started){
      const r=spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],
        {encoding:'utf8',timeout:30000});
      assert.equal(r.status,0,r.stderr||r.error?.message);
    }
    rmSync(root,{recursive:true,force:true});
  }
});
