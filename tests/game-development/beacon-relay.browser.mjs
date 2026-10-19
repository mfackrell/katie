// Explicit opt-in integration check: serve the built app locally before running.
// BEACON_RELAY_ORIGIN=http://127.0.0.1:3100 node tests/game-development/beacon-relay.browser.mjs
import assert from 'node:assert/strict';
import {runScenarios} from '../../scripts/project-browser-engine.mjs';
import {browserContract} from './beacon-relay.acceptance.mjs';
const origin=process.env.BEACON_RELAY_ORIGIN;
if(!origin) throw Error('Set BEACON_RELAY_ORIGIN to the local built Next.js server. No deployed or production origin is accepted.');
const checks=await runScenarios(browserContract,origin);
console.log(JSON.stringify({browserChecks:checks,scope:'local built route; no immutable Preview tested'},null,2));
assert.equal(checks.length,browserContract.scenarios.length);
assert.ok(checks.every(c=>c.passed),JSON.stringify(checks));
