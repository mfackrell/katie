import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('serverless preview retains packaged Chromium flags and isolates each scenario in a new browser',()=>{
 const s=readFileSync('scripts/project-browser-engine.mjs','utf8');
 assert.match(s,/args:\s*deployed\s*\?\s*chromium\.args\s*:\s*chromium\.args\.filter/);
 assert.match(s,/if \(!deployed\) browser = await launch\(\)/);
 assert.match(s,/if\(deployed\) browser = await launch\(\)/);
 assert.match(s,/if\(deployed\) \{ await browser\?\.close/);
 assert.match(s,/const context = await browser\.newContext\(/);
 assert.match(s,/serviceWorkers: 'block'/);
 assert.match(s,/localRequestAllowed\(request\.url\(\), origin, request\.method\(\)\)/);
});
