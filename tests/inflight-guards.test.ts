import test from "node:test";
import assert from "node:assert/strict";
import { beginInFlightRequest, endInFlightRequest } from "../lib/chat/inflight-guards";

test("beginInFlightRequest blocks duplicate actor requests", () => {
  const inFlight = new Set<string>();

  assert.equal(beginInFlightRequest(inFlight, "actor-1"), true);
  assert.equal(beginInFlightRequest(inFlight, "actor-1"), false);
  assert.equal(inFlight.size, 1);
});

test("ending a request allows a subsequent create action", () => {
  const inFlight = new Set<string>();

  assert.equal(beginInFlightRequest(inFlight, "actor-1"), true);
  endInFlightRequest(inFlight, "actor-1");
  assert.equal(beginInFlightRequest(inFlight, "actor-1"), true);
});
