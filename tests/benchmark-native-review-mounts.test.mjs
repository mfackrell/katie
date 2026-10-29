import test from 'node:test';
import assert from 'node:assert/strict';
import {attestedReviewSdkMode} from '../scripts/benchmark/shared-native-phase.mjs';
const line=(path,flags='ro')=>`42 21 0:1 / ${path} ${flags},nosuid - overlay overlay rw`;
const check=mountInfo=>attestedReviewSdkMode({rootRealPath:'/work',cwdRealPath:'/work',mountInfo});
test('inner SDK namespace is omitted only with kernel-attested read-only work and descendant mounts',()=>{
 assert.equal(check([line('/work'),line('/work/.git'),line('/work/node_modules'),line('/tmp','rw')].join('\n')),'danger-full-access');
 assert.equal(check([line('/work'),line('/workspace','rw')].join('\n')),'danger-full-access');
 for(const mounts of ['',line('/tmp'),line('/work','rw'),[line('/work'),line('/work/.git','rw')].join('\n'),[line('/work'),line('/work/node_modules','rw')].join('\n'),[line('/work'),line('/work/my\\040data','rw')].join('\n'),line('/work','ro,rw'),'malformed'])
  assert.throws(()=>check(mounts),/OUTER_BOUNDARY_MISSING/);
});
test('environment attestation cannot substitute for exact real cwd and workspace boundary',()=>{
 for(const [rootRealPath,cwdRealPath] of [['/tmp/work','/work'],['/work','/tmp/work'],['/work/link','/work']])
  assert.throws(()=>attestedReviewSdkMode({rootRealPath,cwdRealPath,mountInfo:line('/work')}),/OUTER_BOUNDARY_MISSING/);
});
