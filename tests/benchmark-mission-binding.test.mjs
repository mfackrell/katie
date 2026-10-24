import test from 'node:test';import assert from 'node:assert/strict';
import {benchmarkMissionGate} from '../lib/missions/benchmark-binding.mjs';
const base={missionId:'mission-1',arm:'orchestrated',baselineSha:'a'.repeat(40)};
const binding={verifiedByServer:true,accountId:'acct',experimentId:'exp',...base};
test('ordinary mission keeps existing reservation behavior',async()=>{
 const regular=async()=>true;
 assert.equal(benchmarkMissionGate({...base,binding:null,ordinaryReserve:regular}),regular);
});
test('verified benchmark binds account and call',async()=>{
 const reserve=benchmarkMissionGate({...base,binding,ordinaryReserve:()=>{},benchmarkReserve:async(a,r)=>({a,r})});
 const result=await reserve({tokens:10});assert.equal(result.a.accountId,'acct');assert.equal(result.r.tokens,10);
});
test('forged and mismatched bindings rejected before dispatch',()=>{
 for(const bad of [{...binding,verifiedByServer:false},{...binding,missionId:'other'},{...binding,arm:'direct'}])
  assert.throws(()=>benchmarkMissionGate({...base,binding:bad,ordinaryReserve:()=>{},benchmarkReserve:()=>{}}),/UNVERIFIED/);
});
test('benchmark never falls back to ordinary billing',()=>{
 assert.throws(()=>benchmarkMissionGate({...base,binding,ordinaryReserve:()=>true}),/RESERVE_UNAVAILABLE/);
});
