import test from 'node:test';
import assert from 'node:assert/strict';
import {modules} from './helpers/load-project-modules.mjs';

const {immediateWorkerAssignmentDirective,assertManagementCommands}=
 modules()('@/lib/projects/organization');
const ROOT='c486ade1-2a9c-4cd5-a80b-90c032e4e03e';
const DELIVERY='9b62ae62-a499-490a-a7ac-6e6c5bb1229d';
const MANAGER='a00de7ce-4159-49ac-9628-a070d5dbaffd';
const WORKER='6c585f55-aed3-43cb-903b-15f5d4fb95a2';

test('Mission92 Game Delivery has a direct manager, not a directly reporting worker',()=>{
 const delivery={id:DELIVERY,parent_id:ROOT,kind:'manager',
  management_level:'functional_director',tools:['manage','development'],status:'active'};
 const manager={id:MANAGER,parent_id:DELIVERY,kind:'manager',
  management_level:'manager',tools:['manage','development'],status:'active'};
 const grandchild={id:WORKER,parent_id:MANAGER,kind:'worker',
  management_level:'worker',tools:['analysis','repository_review'],status:'active'};
 const guidance=immediateWorkerAssignmentDirective(delivery,[delivery,manager,grandchild],[]);
 assert.match(guidance,/There are NO directly reporting workers/);
 assert.match(guidance,/do NOT emit assign/i);
 assert.match(guidance,/does not convert that manager to a worker/i);
 assert.match(guidance,/direct manager\/report IDs \(NOT worker assignment targets\)/);
 assert.ok(guidance.includes(MANAGER));
 assert.ok(!guidance.includes('"nodeId":"'+WORKER+'"'),'Grandchild must not appear as lawful direct worker');
 const invalid={action:'assign',nodeId:WORKER,capability:'analysis'};
 assert.throws(()=>assertManagementCommands(delivery,[delivery,manager,grandchild],[invalid]),
  e=>e?.evidence?.code==='immediate_reporting_authority');
 // The existing SQL worker-identity check remains authoritative even if the
 // model incorrectly selects the direct MANAGER, which is not a worker.
 assert.match(guidance,/target.kind="worker"/);
});

test('Lawful direct worker has explicit exact tools, while a manager never gains worker authority',()=>{
 const manager={id:MANAGER,kind:'manager',status:'active',tools:['manage','development']};
 const worker={id:WORKER,parent_id:MANAGER,kind:'worker',status:'active',
  tools:['analysis','repository_review']};
 const guidance=immediateWorkerAssignmentDirective(manager,[manager,worker],[]);
 assert.ok(guidance.includes('"nodeId":"'+WORKER+'"'));
 assert.match(guidance,/For assign, use ONLY a listed direct worker/);
 assert.doesNotMatch(guidance,/There are NO directly reporting workers/);
 assert.doesNotThrow(()=>assertManagementCommands(manager,[manager,worker],[
  {action:'assign',nodeId:WORKER,capability:'analysis'}
 ]));
});
