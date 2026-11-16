import test from 'node:test';
import assert from 'node:assert/strict';
import {integratedOwnerBrowser} from './helpers/lifecycle-owner-integrated-browser.mjs';
import {partialMoneyFixture} from './fixtures/lifecycle-partial-money.mjs';
import {lifecycleProposalFromSnapshot} from '../scripts/benchmark/lifecycle-owner-proposal.mjs';
import config from '../config/benchmark-715-production-qualification.json' with {type:'json'};
test('qualification Chromium supplies real same-origin POST headers without disabling web security',{timeout:60000},async()=>{
 const f=partialMoneyFixture();f.now=Date.now();f.snapshot.position.expiresAt=f.now+3600000;f.snapshot.pricing.verifiedAt=f.now-1000;
 const proposal=lifecycleProposalFromSnapshot(f).proposal;let state='pending',posts=0;
 // Transport regression only; actual authenticated route/SQL are exercised by
 // the hosted integrated lifecycle. This stub grants no authority.
 const route={GET:async()=>Response.json({state,proposal}),POST:async request=>{assert.equal(request.headers.get('origin'),config.productionUrl);assert.equal(request.headers.get('authorization'),'Bearer task2c-synthetic-owner');assert.equal((await request.json()).decision,'rejected');posts++;state='rejected';return Response.json({state,proposal});}};
 await integratedOwnerBrowser(route,async page=>{await page.getByRole('button',{name:'Reject amendment'}).click();await page.getByText('Owner rejected; saved work remains recoverable',{exact:true}).waitFor();});
 assert.equal(posts,1);
});
