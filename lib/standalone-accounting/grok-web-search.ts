import { priceTokenUsage, type ModelPrice } from "./pricing";

/** Reviewed xAI global standard Web Search tool pricing, 2026-11-15.
 * https://docs.x.ai/developers/pricing
 * https://docs.x.ai/developers/tools/tool-usage-details
 * Web search is $5 / 1,000 successful tool calls, PLUS model tokens.
 * Do not confuse it with X Search's per-post/profile billing.
 */
export const GROK_BOUNDED_WEB_POLICY_VERSION = "grok-web-2026-11-15-v1";
export const GROK_WEB_SEARCH_FEE_MICROUSD = 5_000n;
export const GROK_WEB_MAX_OUTPUT_TOKENS = 2048;

type Json = Record<string, unknown>;
const object = (v:unknown):v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function isBoundedGrokWebRequest(
  request:{provider:string;endpoint:string;payload:Json},
):boolean {
  const {provider,endpoint,payload:p} = request;
  if(provider!=="grok" || !["/v1/responses","responses"].includes(endpoint))return false;
  if(p.max_turns!==1 || p.parallel_tool_calls!==false ||
    !Number.isSafeInteger(p.max_output_tokens) ||
    Number(p.max_output_tokens)<=0 || Number(p.max_output_tokens)>GROK_WEB_MAX_OUTPUT_TOKENS)return false;
  if(!Array.isArray(p.tools) || p.tools.length!==1 || !object(p.tools[0]) ||
    Object.keys(p.tools[0]).length!==1 || p.tools[0].type!=="web_search")return false;
  if(!Array.isArray(p.include) || p.include.length!==1 ||
    p.include[0]!=="web_search_call.action.sources")return false;
  if(p.stream===true || p.tool_choice!==undefined || p.store===false)return false;
  return true;
}

/** One tool-call turn with parallel execution forbidden can admit one
 * Web Search invocation. Conservatively reserve TWO full model context windows
 * (initial decision plus final synthesis) at the highest applicable tier,
 * plus two output allowances and the reviewed $0.005 server-tool fee.
 * This is an intentionally high exposure ceiling, not a predicted charge;
 * existing owner approval rules decide whether the request may proceed.
 */
export function boundedGrokWebReservationMicrousd(price:ModelPrice,outputAllowance:number):string {
  if(!Number.isSafeInteger(outputAllowance)||outputAllowance<=0||
    outputAllowance>GROK_WEB_MAX_OUTPUT_TOKENS)throw Error("Unbounded web-search output");
  if(!Number.isSafeInteger(price.maxContextTokens)||price.maxContextTokens<=0)
    throw Error("Unverified web-search context limit");
  const each = BigInt(priceTokenUsage(price,price.maxContextTokens,outputAllowance));
  return (2n*each+GROK_WEB_SEARCH_FEE_MICROUSD).toString();
}

export type BoundedGrokSearchCost = {
  actualMicrousd:string;
  providerCostTicks:string;
  webSearchCalls:number;
};
/** The provider's own cost_in_usd_ticks covers model and server tool costs.
 * 1 USD = 10^10 ticks; 1 microUSD = 10^4 ticks. Preserve full provider
 * tick evidence and round exposure upwards to the ledger's microUSD unit.
 */
export function boundedGrokWebCostFromReceipt(
  usage:Json,reservationMicrousd:string,
):BoundedGrokSearchCost {
  const ticks=usage.cost_in_usd_ticks;
  if(typeof ticks!=="number"||!Number.isSafeInteger(ticks)||ticks<0)
    throw Error("Missing or invalid xAI provider-billed cost ticks");
  const details=usage.server_side_tool_usage_details;
  if(!object(details))throw Error("Missing billed xAI server-tool usage details");
  const web=details.web_search_calls;
  if(typeof web!=="number"||!Number.isSafeInteger(web)||web<0||web>1)
    throw Error("xAI Web Search exceeded the one-call limit or usage is unavailable");
  for(const [name,value] of Object.entries(details)) {
    if(name==="web_search_calls")continue;
    if(typeof value!=="number"||!Number.isSafeInteger(value)||value!==0)
      throw Error("Unpriced xAI server-tool usage: "+name);
  }
  const count=usage.num_server_side_tools_used;
  if(count!==undefined && (!Number.isSafeInteger(count)||count!==web))
    throw Error("Conflicting xAI tool-use totals");
  const bill=(BigInt(ticks)+9_999n)/10_000n;
  if(!/^\d+$/.test(reservationMicrousd)||bill>BigInt(reservationMicrousd))
    throw Error("Provider-billed xAI web-search cost exceeded authorized reservation");
  return {actualMicrousd:bill.toString(),providerCostTicks:String(ticks),webSearchCalls:web};
}
