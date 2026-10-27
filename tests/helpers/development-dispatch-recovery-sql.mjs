import {readFileSync} from 'node:fs';
export async function verifyDevelopmentDispatchRecoverySql(db){
 const fixture=JSON.parse(readFileSync('tests/fixtures/take-eleven-specification-696.json','utf8'));
 await db.query('begin');
 try{
  // Isolated fixture server only: keep pre-existing test missions out of claims.
  await db.query("update work_projects set status='paused' where status='running';update agent_missions set status='blocked' where status='running'");
  await db.query("select set_config('katie.test.saved_spec',$1,true)",[fixture.jobs.find(j=>j.role==='revise').result.text]);
  await db.query(readFileSync('tests/fixtures/development-dispatch-recovery.sql','utf8'));
 }finally{await db.query('rollback');}
}
