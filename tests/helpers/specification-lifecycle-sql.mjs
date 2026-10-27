import {readFileSync} from 'node:fs';
import {modules} from './load-project-modules.mjs';
export async function verifySpecificationLifecycleSql(db){
 const fixture=JSON.parse(readFileSync('tests/fixtures/take-eleven-specification-696.json','utf8'));
 const load=modules(),{digest}=load('@/lib/projects/contract'),{specificationRecoveryKey}=load('@/lib/projects/specification-recovery');
 const candidate=fixture.jobs.find(j=>j.role==='revise').result.text;
 await db.query('begin');
 try{
  await db.query("select set_config('katie.test.saved_spec',$1,true)",[candidate]);
  await db.query("select set_config('katie.test.expected_recovery_key',$1,true)",[specificationRecoveryKey(digest(JSON.parse(candidate)),'Controlled original specification recovery fixture','')]);
  await db.query(readFileSync('tests/fixtures/specification-lifecycle.sql','utf8'));
 }finally{await db.query('rollback');}
}
