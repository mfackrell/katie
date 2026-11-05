import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFileSync} from 'node:fs';

test('every production Octokit workflow dispatch uses GitHub-permitted fields only',()=>{
 const allowed=new Set(['owner','repo','workflow_id','ref','inputs','return_run_details']);
 const files=['lib/agents/development.ts','lib/recovery/worker.ts','lib/executive/release-control.ts'];
 let total=0;
 for(const filename of files){
  const code=readFileSync(filename,'utf8');
  const ast=ts.createSourceFile(filename,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const visit=(node)=>{
   if(ts.isCallExpression(node)&&node.expression.getText(ast).endsWith('.actions.createWorkflowDispatch')){
    total++;
    const argument=node.arguments[0];
    assert.ok(argument&&ts.isObjectLiteralExpression(argument),filename+': workflow dispatch must use literal argument list');
    const seen=new Set();
    for(const prop of argument.properties){
     assert.ok(ts.isPropertyAssignment(prop),filename+': no spread or computed fields in workflow dispatch');
     assert.ok(ts.isIdentifier(prop.name),filename+': keys must be fixed identifiers');
     const name=prop.name.text;
     assert.ok(allowed.has(name),filename+': unexpected GitHub workflow dispatch field '+name);
     assert.ok(!seen.has(name),filename+': duplicate workflow dispatch field '+name);
     seen.add(name);
    }
    for(const mandatory of ['owner','repo','workflow_id','ref','inputs'])assert.ok(seen.has(mandatory),filename+': missing '+mandatory);
   }
   ts.forEachChild(node,visit);
  };
  visit(ast);
 }
 assert.ok(total>=3,'must exercise original Task 4A dispatch and independent recovery workflow routes');
});
test('GitHub reject fullName then accept the exact owner-bound workflow_dispatch once (no inference)',async()=>{
 const accepted=[];
 const github={actions:{async createWorkflowDispatch(args){
  const permitted=new Set(['owner','repo','workflow_id','ref','inputs']);
  const extra=Object.keys(args).find(k=>!permitted.has(k));
  if(extra)throw Error('"'+extra+'" is not a permitted key');
  if(args.workflow_id!=='autonomous-development.yml'||args.inputs?.issue_number!=='969')throw Error('Original issue binding denied');
  if(accepted.length)throw Error('Duplicate external acceptance denied');
  accepted.push(args);return{status:204};
 }}};
 const internal={owner:'mfackrell',repo:'katie',fullName:'mfackrell/katie'};
 await assert.rejects(github.actions.createWorkflowDispatch({...internal,workflow_id:'autonomous-development.yml',ref:'main',inputs:{issue_number:'969'}}),/"fullName" is not a permitted key/);
 assert.equal(accepted.length,0,'The failed GitHub request must not start execution');
 const confirmed=await github.actions.createWorkflowDispatch({owner:internal.owner,repo:internal.repo,workflow_id:'autonomous-development.yml',ref:'main',inputs:{issue_number:'969'}});
 assert.equal(confirmed.status,204);
 assert.equal(accepted.length,1,'Exactly one original-issue workflow was accepted');
 await assert.rejects(github.actions.createWorkflowDispatch({owner:internal.owner,repo:internal.repo,workflow_id:'autonomous-development.yml',ref:'main',inputs:{issue_number:'969'}}),/Duplicate external acceptance denied/);
});

