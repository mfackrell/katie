import test from 'node:test';
import assert from 'node:assert/strict';
import {createRefreshFlight} from '../lib/standalone-accounting/refresh-flight';
test('timer drops, focus/update coalesce and no refresh transports overlap',async()=>{
 let calls=0,active=0,max=0;const release:Array<()=>void>=[];
 const flight=createRefreshFlight(async()=>{calls++;active++;max=Math.max(max,active);await new Promise<void>(r=>release.push(r));active--;});
 const first=flight.refresh();assert.equal(calls,1);
 void flight.refresh(false);assert.equal(calls,1);
 for(let i=0;i<20;i++)void flight.refresh(true);
 assert.equal(calls,1);release.shift()!();await new Promise(r=>setTimeout(r,0));assert.equal(calls,2);
 release.shift()!();await first;assert.equal(max,1);assert.equal(calls,2);flight.dispose();
});
test('dispose aborts an old scope, drops queued work, and cannot restart it',async()=>{
 let calls=0,aborted=false;let release!:()=>void;
 const flight=createRefreshFlight(async signal=>{calls++;signal.addEventListener('abort',()=>{aborted=true;});await new Promise<void>(r=>release=r);});
 const pending=flight.refresh();void flight.refresh();flight.dispose();assert.equal(aborted,true);release();await pending;await flight.refresh();assert.equal(calls,1);
});
test('a completed or failed transport releases the flight for later refresh',async()=>{
 let calls=0;const flight=createRefreshFlight(async()=>{calls++;if(calls===1)throw Error('transient');});
 await assert.rejects(flight.refresh());await flight.refresh();assert.equal(calls,2);
});
