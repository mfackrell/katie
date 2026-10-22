import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichResourceForecast} from '../lib/projects/resource-economics.mjs';
const base={totals:{lowerTokens:100000,expectedTokens:200000,upperTokens:350000},workPackages:[],spendingAuthorization:'unchanged'};
test('unverified prices and missing utilization do not fabricate cost or time',()=>{
 const v=enrichResourceForecast(base,{models:[{pricing_status:'estimated',pricing_input_per_1m:1,pricing_output_per_1m:4,pricing_verified_at:'2026-10-01'}]});
 assert.equal(v.estimatedApiCostUsd,null);
 assert.equal(v.estimatedElapsedHours,null);
 assert.equal(v.estimatedToolCostUsd,null);
 assert.equal(v.estimatedInfrastructureCostUsd,null);
 assert.ok(v.missingInputs.includes('verified_model_pricing'));
 assert.equal(v.spendingAuthorization,'unchanged');
});
test('verified model envelopes account for separate input and output prices',()=>{
 const rates=[
  {provider_name:'a',model_id:'fast',pricing_status:'verified',pricing_input_per_1m:1,pricing_output_per_1m:3,pricing_verified_at:'2026-10-01'},
  {provider_name:'b',model_id:'deep',pricing_status:'verified',pricing_input_per_1m:5,pricing_output_per_1m:15,pricing_verified_at:'2026-10-01'}
 ];
 const r=enrichResourceForecast(base,{models:rates,observedOutputFraction:.25,observedTokensPerHour:50000,observedFixedHours:2,confirmedParallelWorkers:2,tools:[{quantity:2,unitPriceUsd:3}],infrastructure:[{quantity:4,unitPriceUsd:.5}],calibration:{samples:5,actualToEstimatedMedian:1.2}});
 assert.equal(r.apiCostRange.lowUsd,.15);
 assert.equal(r.apiCostRange.highUsd,2.625);
 assert.equal(r.estimatedToolCostUsd,6);
 assert.equal(r.estimatedInfrastructureCostUsd,2);
 assert.equal(r.estimatedElapsedHours.expected,4);
 assert.equal(r.calibratedEstimate.expectedTokens,240000);
 assert.equal(r.spendingAuthorization,'unchanged');
});
test('zero/missing prices, insufficient historical samples and unverified cost inputs are unavailable',()=>{
 const r=enrichResourceForecast(base,{models:[{pricing_status:'verified',pricing_input_per_1m:0,pricing_output_per_1m:2,pricing_verified_at:'today'}],observedOutputFraction:.4,calibration:{samples:2,actualToEstimatedMedian:1.5},tools:[{quantity:1}],infrastructure:[]});
 assert.equal(r.apiCostRange,null);
 assert.equal(r.calibratedEstimate,null);
 assert.equal(r.estimatedToolCostUsd,null);
 assert.equal(r.estimatedInfrastructureCostUsd,null);
});
