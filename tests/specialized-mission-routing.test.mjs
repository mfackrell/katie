import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('lib/missions/model.ts','utf8');
test('native tool routing retains capability selection and authorization',()=>{
 assert.match(source,/selectNativeToolModel/);
 assert.match(source,/chooseProvider\(kind/);
 assert.match(source,/providerUnavailable:true/);
 assert.match(source,/reserve_mission_call/);
});
