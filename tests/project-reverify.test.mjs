import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('immutable re-verification workflow never launches coding or repair',()=>{
 const source=readFileSync('.github/workflows/project-reverify.yml','utf8');
 assert.match(source,/workflow_dispatch:/);
 assert.match(source,/expected_sha:/);
 assert.match(source,/\.head\.sha == \$sha/);
 assert.match(source,/\.draft == true/);
 assert.match(source,/\.base\.repo\.full_name == \$repo/);
 assert.match(source,/project-scope\.mjs/);
 assert.match(source,/project-ci\.mjs/);
 assert.match(source,/ref: \$\{\{ needs\.build\.outputs\.sha \}\}/);
 assert.match(source,/permission-profile: ':read-only'/);
 assert.match(source,/agent-completion/);
 assert.doesNotMatch(source, /Autonomous developer|Independent repair agent|git push|git commit|npm run build.*--prod/);
});

test('baseline installation errors are classified only by trusted verifier',()=>{
 const source=readFileSync('scripts/project-ci.mjs','utf8');
 assert.match(source,/project-verification-failure\.json/);
 assert.match(source,/kind:'infrastructure'/);
 assert.match(source,/stage:'baseline-install'/);
 assert.match(source,/if\(install\.status!==0\)/);
 assert.match(source,/sandboxArgs\(root,\{dependencies,writable:true\}\)/);
 assert.match(source,/--unshare-net|sandboxArgs/);
});
