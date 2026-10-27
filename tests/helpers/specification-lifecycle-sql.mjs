import {readFileSync} from 'node:fs';
export async function verifySpecificationLifecycleSql(db){
 const fixture=JSON.parse(readFileSync('tests/fixtures/take-eleven-specification-696.json','utf8'));
 await db.query('begin');
 try{
  await db.query("select set_config('katie.test.saved_spec',$1,true)",[fixture.jobs.find(j=>j.role==='revise').result.text]);
  await db.query(readFileSync('tests/fixtures/specification-lifecycle.sql','utf8'));
 }finally{await db.query('rollback');}
}
