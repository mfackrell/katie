import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateProjectResources} from '../lib/projects/resource-forecast.mjs';
const scenario=(count)=>Array.from({length:count},(_,i)=>({name:'scenario'+i,steps:[{action:'goto',path:'/'},{action:'expectVisible',selector:'#ready'}]}));
const make=(size)=>({
 summary:size?'Multiplayer game with database API persistence, authentication, external provider integration, UI and deployment':'A simple one page display',
 requirements:Array.from({length:size?20:2},(_,i)=>'Requirement '+i),
 allowedPaths:Array.from({length:size?9:1},(_,i)=>'app/item'+i+'.tsx'),
 milestones:Array.from({length:size?5:1},(_,i)=>({title:'Milestone '+i,instruction:'Build verified feature',contract:{path:'/',scenarios:scenario(1)}})),
 finalContract:{path:'/',scenarios:scenario(size?15:1)},
 ...(size?{game:{rules:Array.from({length:12},(_,i)=>({id:'rule'+i}))}}:{})
});
test('scope changes the work-package estimate without fixed 600K ceiling',()=>{
 const small=estimateProjectResources(make(false),'Show a page');
 const large=estimateProjectResources(make(true),'Build multiplayer UI, Supabase database, API, auth and integrations');
 assert.ok(large.totals.expectedTokens>small.totals.expectedTokens);
 assert.ok(large.workPackages.length>=5);
 assert.equal(large.totals.expectedTokens,large.workPackages.reduce((sum,x)=>sum+x.estimatedTokens,0));
 assert.equal(large.spendingAuthorization,'unchanged');
});
test('uncertain scope widens forecast and no costs are fabricated',()=>{
 const base=estimateProjectResources(make(false),'Show a page');
 const uncertain=estimateProjectResources(make(false),'Unknown migration requirements: investigate');
 assert.ok(uncertain.totals.upperTokens>base.totals.upperTokens);
 assert.equal(uncertain.estimatedApiCostUsd,null);
 assert.equal(uncertain.estimatedToolCostUsd,null);
 assert.equal(uncertain.estimatedInfrastructureCostUsd,null);
 assert.equal(uncertain.estimatedElapsedHours,null);
});
