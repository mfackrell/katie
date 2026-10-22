// The forecast remains distinct from spend authorization. Prices are accepted
// only from independently verified registry records, never guessed from model names.
const finitePositive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
export function enrichResourceForecast(base, inputs={}) {
 const rates=(inputs.models??[]).filter(r=>r.pricing_status==='verified'&&finitePositive(r.pricing_input_per_1m)&&finitePositive(r.pricing_output_per_1m)&&r.pricing_verified_at);
 const outputFraction=inputs.observedOutputFraction;
 const splitsValid=typeof outputFraction==='number'&&Number.isFinite(outputFraction)&&outputFraction>=0&&outputFraction<=1;
 const priced=splitsValid?rates.map(r=>{
  const perToken=((1-outputFraction)*r.pricing_input_per_1m+outputFraction*r.pricing_output_per_1m)/1e6;
  return {provider:r.provider_name,model:r.model_id,perToken,source:'verified_model_registry',verifiedAt:r.pricing_verified_at};
 }):[];
 const cheapest=priced.length?Math.min(...priced.map(x=>x.perToken)):null;
 const highest=priced.length?Math.max(...priced.map(x=>x.perToken)):null;
 // These are provider-choice scenarios, NOT a claim that the router will use
 // the cheapest model, or an artificial model allocation.
 const apiCostRange=cheapest===null?null:{
   lowUsd:base.totals.lowerTokens*cheapest,
   highUsd:base.totals.upperTokens*highest,
   pricingModels:priced,
   source:'verified_registry_scenario_envelope',
   note:'Actual intelligent model routing can change the provider and price per task.'
 };
 const tools=inputs.tools??[];
 const infrastructure=inputs.infrastructure??[];
 const sumCharges=rows=>rows.length&&rows.every(x=>finitePositive(x.unitPriceUsd)&&Number.isInteger(x.quantity)&&x.quantity>=0)
    ?rows.reduce((sum,x)=>sum+x.quantity*x.unitPriceUsd,0):null;
 const toolCost= sumCharges(tools);
 const infraCost=sumCharges(infrastructure);
 const samples=(inputs.missionHistory??[]).map(r=>{const hours=(Date.parse(r.updated_at)-Date.parse(r.created_at))/3600000;return hours>0&&r.actual_tokens>0?r.actual_tokens/hours:null;}).filter(finitePositive).sort((a,b)=>a-b);
 const measuredThroughput=samples.length>=5?samples[Math.floor(samples.length/2)]:null;
 const duration=inputs.observedTokensPerHour??measuredThroughput;
 const overhead=inputs.observedFixedHours??(measuredThroughput?0:null);
 const concurrency=inputs.confirmedParallelWorkers??(measuredThroughput?1:null);
 const hours=finitePositive(duration)&&finitePositive(concurrency)&&typeof overhead==='number'&&Number.isFinite(overhead)&&overhead>=0
  ? {lower:base.totals.lowerTokens/duration/concurrency+overhead,expected:base.totals.expectedTokens/duration/concurrency+overhead,upper:base.totals.upperTokens/duration/concurrency+overhead,source:measuredThroughput&&!inputs.observedTokensPerHour?'historical_mission_wall_clock_throughput_single_worker':'observed_throughput_and_confirmed_worker_capacity'}
  :null;
 const calibration=inputs.calibration??null;
 const validCalibration=calibration&&Number.isInteger(calibration.samples)&&calibration.samples>=3&&finitePositive(calibration.actualToEstimatedMedian);
 // Calibrate range conservatively only with a minimum sample of comparable
 // completed projects; do not silently overwrite the observed scope estimate.
 const calibrated=validCalibration?{
  sampleCount:calibration.samples,
  expectedTokens:Math.ceil(base.totals.expectedTokens*calibration.actualToEstimatedMedian),
  source:'completed_project_actuals',factor:calibration.actualToEstimatedMedian
 }:null;
 return {...base,version:2,apiCostRange,estimatedApiCostUsd:apiCostRange?{lower:apiCostRange.lowUsd,upper:apiCostRange.highUsd}:null,
 estimatedToolCostUsd:toolCost,estimatedInfrastructureCostUsd:infraCost,
 estimatedElapsedHours:hours,calibratedEstimate:calibrated,
 costBasis:apiCostRange?'Pricing range calculated from verified registry models and observed input/output mix. Model selection remains dynamic.':'Unavailable: verified model prices and observed input/output mix are required.',
 toolCostBasis:toolCost===null?'Unavailable: explicit tool quantity and rates required.':'Based on supplied rate and quantity receipts.',
 infrastructureCostBasis:infraCost===null?'Unavailable: explicit infrastructure usage and rates required.':'Based on supplied rate and quantity receipts.',
 timeBasis:hours?'Based on historical completed mission wall-clock throughput (including waits) and conservative single-worker execution unless explicit measured capacity is provided. External dependencies can extend elapsed time.':'Unavailable: observed throughput, overhead, and confirmed concurrency required.',
 missingInputs:[
 ...(!rates.length?['verified_model_pricing']:[]),...(!splitsValid?['observed_input_output_split']:[]),
 ...(toolCost===null?['tool_rates_and_quantities']:[]),
 ...(infraCost===null?['infrastructure_rates_and_quantities']:[]),
 ...(hours===null?['observed_throughput_and_capacity']:[]),
 ...(!calibrated?['comparable_completed_project_calibration']:[])
 ]};
}
