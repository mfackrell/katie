import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('production status, configuration, actions and image admission never use the legacy full snapshot',()=>{
 for(const file of ['app/api/standalone-accounting/usage/route.ts','app/api/standalone-accounting/configuration/route.ts','app/api/standalone-accounting/attempts/route.ts','lib/uploads/still-image-observations.ts']){
  const source=readFileSync(file,'utf8');assert.doesNotMatch(source,/ledger\.snapshot\(|standalone_snapshot/,file);
 }
});
