import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {preflightNativeChild} from './native-child-preflight.mjs';
import {assertTrustedBoundary} from './native-trust-boundary.mjs';

const boundary=assertTrustedBoundary(process.cwd());
const child=resolve('scripts/benchmark/native-development-child.mjs');
preflightNativeChild(boundary,child);
const broken=mkdtempSync(join(tmpdir(),'native-child-regression-'));
try{
 const source=readFileSync(child,'utf8');
 const esm="import {Codex} from '/work/node_modules/@openai/codex-sdk/dist/index.js';";
 assert.ok(source.includes(esm));
 // Reproduce the retained runner failure against the real pinned package.
 writeFileSync(join(broken,'native-development-child.mjs'),source.replace(esm,
  "import {createRequire} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nconst require=createRequire('/work/package.json');\nconst {Codex}=await import(pathToFileURL(require.resolve('@openai/codex-sdk')).href);"));
 for(const file of ['shared-native-phase.mjs','shared-native-policy.mjs'])
  copyFileSync(resolve('scripts/benchmark',file),join(broken,file));
 assert.throws(()=>preflightNativeChild(boundary,join(broken,'native-development-child.mjs')),/ERR_PACKAGE_PATH_NOT_EXPORTED/);
}finally{rmSync(broken,{recursive:true,force:true});}
process.stdout.write('Actual Full child ESM bootstrap passed; retained CommonJS failure reproduced without credentials or model calls.\n');
