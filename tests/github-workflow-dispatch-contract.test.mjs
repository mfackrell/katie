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
