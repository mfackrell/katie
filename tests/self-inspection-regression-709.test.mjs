import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const route=readFileSync('app/api/chat/route.ts','utf8');
const injector=readFileSync('lib/repo/content-injector.ts','utf8');
test('self inspection follow-up matches normal English and rejects unrelated images',()=>{
 const a=route.indexOf('    const continuitySelfInspection =');
 const b=route.indexOf('    const repoGate =',a);
 assert.ok(a>=0&&b>a);
 const calc=runInNewContext('(function(message,recentUserTopic,selfInspectionRequest){'+route.slice(a,b)+';return continuitySelfInspection;})');
 assert.equal(calc('can you see yourself yet?','',false),true);
 assert.equal(calc('take a look','we were inspecting Katie routing code',true),true);
 assert.equal(calc('what is in the photo?','a photo',false),false);
});
test('self source file selection cannot be displaced by incidental filename hints',()=>{
 assert.match(injector,/if \(selfArchitecture\) \{/);
 assert.doesNotMatch(injector,/if \(selfArchitecture && !hints\.length\)/);
 assert.ok(injector.includes('"app/api/chat/route.ts"'));
});
