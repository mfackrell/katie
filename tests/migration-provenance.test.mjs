import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {classifyMigrationHistory} from '../scripts/audit-migration-authority.mjs';

const manifest=JSON.parse(readFileSync(new URL('../scripts/migration-provenance.json',import.meta.url),'utf8'));
const a=manifest.accounting;
const make=()=>({
 expected:new Map([...manifest.native.map(x=>[x.filename,x.sha256]),[a.filename,a.repositorySha256]]),
 custom:[{filename:a.filename,checksum:a.recordedSha256,applied_at:a.appliedAt}],
 native:manifest.native.map(x=>({version:x.version,name:x.name,statement_count:x.statementCount,sha256:x.sha256})),
 catalog:structuredClone(a.catalog),invariants:structuredClone(a.invariants)
});
const plan=f=>classifyMigrationHistory(f.expected,f.custom,f.native,manifest,f.catalog,f.invariants);
test('committed historical sources match the verified immutable provenance bytes',()=>{
 for(const x of manifest.native){
  assert.equal(createHash('sha256').update(readFileSync(new URL('../supabase/migrations/'+x.filename,import.meta.url))).digest('hex'),x.sha256,x.filename);
 }
 assert.equal(createHash('sha256').update(readFileSync(new URL('../supabase/migrations/'+a.filename,import.meta.url))).digest('hex'),a.repositorySha256);
});
test('recognized historical discrepancy stays explicit and all exact native matches are read-only',()=>{
 const f=make(),p=plan(f);
 assert.deepEqual(p.errors,[]);
 assert.equal(p.applied.length,manifest.native.length+1);
 assert.deepEqual(p.pending,[]);
 assert.deepEqual(p.applied.find(x=>x.filename===a.filename),{filename:a.filename,source:'explicit-catalog-reconciliation',recordedSha256:a.recordedSha256,repositorySha256:a.repositorySha256,historicalBytesRecovered:false});
});
for(const [name,mutate] of [
 ['changed committed accounting bytes',f=>f.expected.set(a.filename,'0'.repeat(64))],
 ['changed original ledger checksum',f=>f.custom[0].checksum='0'.repeat(64)],
 ['changed original applied timestamp',f=>f.custom[0].applied_at='2026-11-20T00:00:00.000000+00:00'],
 ['missing original historical row',f=>f.custom=[]],
 ['changed accounting procedure body',f=>f.catalog[0].body_sha='0'.repeat(64)],
 ['changed function execute privileges',f=>f.catalog[0].acl='{postgres=X/postgres,=X/postgres}'],
 ['missing catalog entry',f=>f.catalog.pop()],
 ['changed accounting invariant',f=>f.invariants.uncertainty_trigger_absent=false],
 ['eligible historical finance pauses',f=>f.invariants.legacy_finance_pause_absent=false],
 ['missing native receipt',f=>f.native.pop()],
 ['changed native version',f=>f.native[0].version='20261128000000'],
 ['changed native name',f=>f.native[0].name+='-other'],
 ['native receipt with multiple statements',f=>f.native[0].statement_count=2],
 ['changed native digest',f=>f.native[0].sha256='0'.repeat(64)],
 ['duplicate native version',f=>f.native.push(f.native[0])],
 ['changed historical repository bytes',f=>f.expected.set(manifest.native[0].filename,'0'.repeat(64))],
 ['missing historical repository file',f=>f.expected.delete(manifest.native[0].filename)],
 ['unmapped older migration',f=>f.expected.set('20261101000000_unproven.sql','1'.repeat(64))],
 ['unrelated custom checksum mismatch',f=>{f.expected.set('20261001000000_other.sql','1'.repeat(64));f.custom.push({filename:'20261001000000_other.sql',checksum:'2'.repeat(64)});}]
]){
 test('fails closed: '+name,()=>{const f=make();mutate(f);const p=plan(f);assert.ok(p.errors.length);});
}
test('a new later file remains eligible for normal migration execution',()=>{
 const f=make(),name='20261129000000_new.sql';
 f.expected.set(name,'a'.repeat(64));
 const p=plan(f);assert.deepEqual(p.errors,[]);assert.deepEqual(p.pending,[name]);
});
test('runner uses the same full audit before any historical replay or migration application',()=>{
 const runner=readFileSync(new URL('../scripts/run-migrations.mjs',import.meta.url),'utf8');
 const audit=runner.indexOf('const plan = auditMigrationPlan(databaseUrl,migrationsDir)');
 const gate=runner.indexOf('if(plan.errors.length)',audit),pending=runner.indexOf('for(const file of plan.pending)',gate),apply=runner.indexOf('const apply = spawnSync',pending);
 assert.ok(audit>=0&&gate>audit&&pending>gate&&apply>pending);
 assert.doesNotMatch(runner,/UPDATE\s+(?:public\.)?schema_migrations|DELETE\s+FROM\s+(?:public\.)?schema_migrations/i);
});
