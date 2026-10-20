import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
test('actual PostgREST client sends linked-mission and undelivered-receipt filters intact',async()=>{
 const exports={},requests=[];
 vm.runInNewContext(ts.transpileModule(readFileSync('lib/data/supabase/admin.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
 }).outputText,{exports,URL,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://example.test',SUPABASE_SERVICE_ROLE_KEY:'test'}},
  fetch:async(input)=>{requests.push(new URL(input));return Response.json([]);}});
 const filter='evidence->>acceptanceMissionId.not.is.null,evidence->acceptanceEvidence->0->>missionId.not.is.null';
 const result=await exports.getSupabaseAdminClient().from('executive_provisioning_requests')
  .select('id,evidence').eq('route','configure').in('status',['activated','blocked']).or(filter)
  .is('evidence->>chatDeliveredAt',null).order('updated_at',{ascending:true}).limit(100).returns();
 assert.equal(result.error,null);assert.equal(requests.length,1);
 const params=requests[0].searchParams;
 assert.equal(params.get('or'),'('+filter+')');
 assert.equal(params.get('evidence->>chatDeliveredAt'),'is.null');
 assert.equal(params.get('status'),'in.("activated","blocked")');
 assert.equal(params.get('route'),'eq.configure');assert.equal(params.get('limit'),'100');
});
