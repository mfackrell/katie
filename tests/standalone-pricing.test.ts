import { describe,expect,it } from "vitest";
import { actualCostFromUsage,canonicalJson,estimatePreparedRequest,freezePreparedRequest,prepareStandaloneRequest,inlineImageDimensions,ESTIMATOR_VERSION } from "../lib/standalone-accounting/estimate";
import { getModelPrice,priceTokenUsage,PRICING_SNAPSHOT } from "../lib/standalone-accounting/pricing";
import { reducePreparedRequest } from "../lib/standalone-accounting/reduction";
import { conversationCacheKey,openAiCacheSettings } from "../lib/providers/openai-cache";
const chat=(payload:Record<string,unknown>={},model="gpt-4o")=>prepareStandaloneRequest("openai",model,"/v1/chat/completions",{model,messages:[{role:"user",content:"Hello"}],...payload});
const png=(width:number,height:number)=>{const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return `data:image/png;base64,${b.toString("base64")}`;};
describe("immutable standalone pricing",()=>{
  it("freezes independent clones and hashes canonical payload, model, provider and endpoint",()=>{
    const body={model:"gpt-4o",messages:[{role:"user",content:"hello"}],max_tokens:10};
    const first=freezePreparedRequest("openai","gpt-4o","/v1/chat/completions",body);
    const second=freezePreparedRequest("openai","gpt-4o","/v1/chat/completions",{max_tokens:10,messages:body.messages,model:"gpt-4o"});
    expect(first.hash).toBe(second.hash);body.messages[0].content="mutated";
    expect(first.serializedBody).toContain("hello");expect(Object.isFrozen(first.payload.messages)).toBe(true);
    expect(chat({messages:[{role:"user",content:"changed"}]}).hash).not.toBe(chat().hash);
    expect(freezePreparedRequest("grok","gpt-4o","/v1/chat/completions",second.payload).hash).not.toBe(second.hash);
    expect(()=>canonicalJson({value:undefined})).toThrow();expect(()=>canonicalJson({value:NaN})).toThrow();
  });
  it("uses frozen reviewed rate evidence independent of mutable discovery",()=>{
    expect(Object.isFrozen(PRICING_SNAPSHOT.models[0])).toBe(true);
    expect(getModelPrice("openai","gpt-4o-guessed-alias")).toBeUndefined();
    expect(estimatePreparedRequest(chat({},"new-unpriced-model"))).toMatchObject({status:"unsupported",reservationMicrousd:null});
  });
  it("adds finite output caps before hashing and includes full output in estimated reservation",()=>{
    const prepared=chat();expect(prepared.payload.max_tokens).toBe(4096);
    const result=estimatePreparedRequest(prepared);expect(result.status).toBe("estimated");expect(result.outputAllowance).toBe(4096);expect(result.isCeiling).toBe(false);
    expect(BigInt(result.reservationMicrousd!)).toBeGreaterThan(40960n);
    expect(prepareStandaloneRequest("openai","gpt-5","/v1/chat/completions",{model:"gpt-5",messages:[]}).payload.max_completion_tokens).toBe(4096);
    expect(estimatePreparedRequest(freezePreparedRequest("openai","gpt-4o","/v1/chat/completions",{model:"gpt-4o",messages:[]})).status).toBe("unsupported");
  });
  it("uses exact integer money, cache usage and whole-request tier boundaries",()=>{
    const price=getModelPrice("openai","gpt-5.4")!;
    expect(priceTokenUsage(price,272000,100)).toBe("681500");
    expect(priceTokenUsage(price,272001,100)).toBe("1362255");
    expect(priceTokenUsage(getModelPrice("openai","gpt-4o-mini")!,1,0)).toBe("1");
    expect(priceTokenUsage(getModelPrice("openai","gpt-4o")!,1000,100,500)).toBe("2875");
    expect(()=>priceTokenUsage(price,10,1,11)).toThrow();
    const grok=getModelPrice("grok","grok-4.7")!;
    expect(priceTokenUsage(grok,200000,1)).toBe("800012");
  });
  it("prices only the officially reviewed premium IDs and applies each model's own rules",()=>{
    const response=(model:string,extra:Record<string,unknown>={})=>prepareStandaloneRequest("openai",model,"/v1/responses",{model,input:[{role:"user",content:"Deliberately assigned premium lead"}],max_output_tokens:4096,...extra});
    for(const model of ["gpt-5.4-pro","gpt-5.4-pro-2026-03-05","gpt-5.5-pro","gpt-5.5-pro-2026-04-23"]) {
      expect(estimatePreparedRequest(response(model)).status).toBe("estimated");
      expect(priceTokenUsage(getModelPrice("openai",model)!,1000,100)).toBe("48000");
      expect(getModelPrice("openai",model)!.maxContextTokens).toBe(1050000);
      expect(getModelPrice("openai",model)!.maxOutputTokens).toBe(128000);
      expect(estimatePreparedRequest(chat({},model)).status).toBe("unsupported");
    }
    const pro54=getModelPrice("openai","gpt-5.4-pro")!;
    expect(priceTokenUsage(pro54,272000,100)).toBe("8178000");expect(priceTokenUsage(pro54,272001,100)).toBe("16347060");
    expect(estimatePreparedRequest(response("gpt-5.4-pro",{stream:true})).status).toBe("estimated");
    expect(estimatePreparedRequest(response("gpt-5.5-pro",{stream:true})).status).toBe("unsupported");
    const pro55=getModelPrice("openai","gpt-5.5-pro")!;
    expect(priceTokenUsage(pro55,272001,100)).toBe("8178030");
    expect(priceTokenUsage(pro55,1000,100,500)).toBe("48000");
    expect(estimatePreparedRequest(response("gpt-5.5-pro-guessed-date")).status).toBe("unsupported");
  });
  it("fails closed for unknown paid dimensions, unlimited output and unsupported regions",()=>{
    for(const payload of [{tools:[{type:"web_search"}]},{modalities:["audio"]},{service_tier:"priority"},{max_tokens:-1},{max_tokens:0},{n:2},{input_audio:"abc"}])expect(estimatePreparedRequest(chat(payload)).status).toBe("unsupported");
    expect(estimatePreparedRequest(freezePreparedRequest("openai","gpt-4o","https://eu.api.openai.com/v1/chat/completions",chat().payload)).status).toBe("unsupported");
    expect(estimatePreparedRequest(chat({messages:[{role:"user",content:[{type:"input_file",file_id:"file1"}]}]})).status).toBe("unsupported");
  });
  it("prices inline dimensions and documented OpenAI low-detail images",()=>{
    expect(inlineImageDimensions(png(1024,1024))).toEqual({width:1024,height:1024});
    const high=estimatePreparedRequest(chat({messages:[{role:"user",content:[{type:"image_url",image_url:{url:png(1024,1024),detail:"high"}}]}]}));
    expect(high.imageTokens).toBe(765);expect(high.status).toBe("estimated");
    const low=estimatePreparedRequest(chat({messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://example.com/image.png",detail:"low"}}]}]}));expect(low.imageTokens).toBe(85);
    const unknown=estimatePreparedRequest(chat({messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://example.com/image.png"}}]}]}));expect(unknown.status).toBe("unsupported");
  });
  it("includes Anthropic system strings and documented maximum image allowance",()=>{
    const request=prepareStandaloneRequest("anthropic","claude-sonnet-4-6","/v1/messages",{model:"claude-sonnet-4-6",system:"personality",messages:[{role:"user",content:[{type:"image",source:{type:"url",url:"https://example.com/image"}}]}]});
    expect(estimatePreparedRequest(request)).toMatchObject({status:"estimated",imageTokens:1568});
  });
  it("supports actual Gemini text config and fails on audio/image output/native files",()=>{
    const prepare=(config:Record<string,unknown>,parts:unknown[]=[{text:"hello"}])=>prepareStandaloneRequest("google","gemini-2.5-pro","/v1beta/models/gemini-2.5-pro:generateContent",{contents:[{role:"user",parts}],generationConfig:{responseModalities:["TEXT"],...config}});
    expect(estimatePreparedRequest(prepare({thinkingConfig:{thinkingBudget:100}}))).toMatchObject({status:"estimated",outputAllowance:4196});
    expect(estimatePreparedRequest(prepare({responseModalities:["IMAGE"]})).status).toBe("unsupported");
    expect(estimatePreparedRequest(prepare({},[{fileData:{mimeType:"application/pdf",fileUri:"file://1"}}])).status).toBe("unsupported");
  });
  it("settles only complete supported finite usage and never adds hidden reasoning twice",()=>{
    expect(actualCostFromUsage(chat(),{inputTokens:1000,outputTokens:100,cachedInputTokens:500}).actualMicrousd).toBe("2875");
    expect(()=>actualCostFromUsage(chat(),{inputTokens:1000,outputTokens:100,toolCalls:1})).toThrow();
    expect(()=>actualCostFromUsage(chat(),{inputTokens:1000,outputTokens:NaN})).toThrow();
  });
  it("detects tampered prepared requests even after restoring serialized persisted JSON",()=>{
    const original=chat();const changed=JSON.parse(JSON.stringify(original));changed.payload.messages[0].content="tampered";
    expect(estimatePreparedRequest(changed)).toMatchObject({status:"unsupported",reservationMicrousd:null});
  });
});
describe("frozen no-fee OpenAI cache metadata",()=>{
  it("uses the main stable scoped key within the documented shared 64-character limit",()=>{
    const key=conversationCacheKey("actor","chat");expect(key).toHaveLength(64);expect(key).toMatch(/^katie:v1:[a-f0-9]{55}$/);
    expect(conversationCacheKey("actor","chat")).toBe(key);expect(conversationCacheKey("other","chat")).not.toBe(key);expect(conversationCacheKey("actor","other")).not.toBe(key);
  });
  it("freezes and hashes routing/retention metadata while reserving identical full uncached input",()=>{
    const model="gpt-5.4",key=conversationCacheKey("actor","chat");
    const prepare=(settings:Record<string,unknown>)=>prepareStandaloneRequest("openai",model,"/v1/responses",{model,input:[{role:"user",content:"Cacheable stable instructions and the current question"}],max_output_tokens:4096,...settings});
    const plain=prepare({}),cached=prepare(openAiCacheSettings(model,key)),quote=estimatePreparedRequest(cached),baseline=estimatePreparedRequest(plain);
    expect(cached.payload.prompt_cache_key).toBe(key);expect(cached.payload.prompt_cache_retention).toBe("24h");expect(cached.hash).not.toBe(plain.hash);
    expect(prepare({prompt_cache_key:"different-key",prompt_cache_retention:"24h"}).hash).not.toBe(cached.hash);
    expect(prepare({prompt_cache_key:key,prompt_cache_retention:"in_memory"}).hash).not.toBe(cached.hash);
    expect(quote.status).toBe("estimated");expect(quote.estimatorVersion).toBe("standalone-estimator-v3");expect(quote.inputTokens).toBe(baseline.inputTokens);expect(quote.reservationMicrousd).toBe(baseline.reservationMicrousd);
    expect(quote.assumptions.join(" ")).toContain("reserves full uncached input");
    expect(actualCostFromUsage(cached,{inputTokens:1000,outputTokens:100,cachedInputTokens:500}).actualMicrousd).toBe("2875");
    const restored=JSON.parse(JSON.stringify(cached));restored.payload.prompt_cache_retention="in_memory";expect(estimatePreparedRequest(restored).status).toBe("unsupported");
  });
  it("allows only reviewed exact-model legacy retention settings",()=>{
    const prepare=(model:string,retention:string)=>prepareStandaloneRequest("openai",model,"/v1/responses",{model,input:"Hello",max_output_tokens:4096,prompt_cache_key:"valid-key",prompt_cache_retention:retention});
    for(const model of ["gpt-4.1","gpt-5","gpt-5.4","gpt-5.5-pro","gpt-5.5-pro-2026-04-23"])expect(estimatePreparedRequest(prepare(model,"24h")).status).toBe("estimated");
    for(const model of ["gpt-4o","gpt-4o-mini","gpt-5-mini","gpt-5.4-pro","gpt-5.4-pro-2026-03-05","o3-pro"]) {
      expect(estimatePreparedRequest(prepare(model,"24h")).status).toBe("unsupported");expect(estimatePreparedRequest(prepare(model,"in_memory")).status).toBe("estimated");
    }
    expect(estimatePreparedRequest(prepare("gpt-5.5-pro","in_memory")).status).toBe("unsupported");
    for(const model of ["gpt-6.1-sol","gpt-5.6","gpt-5.4-unverified-snapshot","toString","__proto__"])expect(estimatePreparedRequest(prepare(model,"24h")).status).toBe("unsupported");
  });
  it("rejects malformed keys, retention types, paid-write options and cache metadata on other providers",()=>{
    for(const key of [""," ","x".repeat(65),"bad\nkey","bad\u0000key","\ud800",42,null,{},[]])expect(estimatePreparedRequest(chat({prompt_cache_key:key})).status).toBe("unsupported");
    for(const retention of ["30m","12h","forever",null,{},0])expect(estimatePreparedRequest(chat({prompt_cache_key:"valid",prompt_cache_retention:retention})).status).toBe("unsupported");
    for(const options of [{ttl:"30m"},{ttl:"12h"},{mode:"explicit",ttl:"30m"}])expect(estimatePreparedRequest(chat({prompt_cache_key:"valid",prompt_cache_options:options})).status).toBe("unsupported");
    expect(estimatePreparedRequest(chat({messages:[{role:"user",content:[{type:"text",text:"hello",prompt_cache_breakpoint:{mode:"explicit",ttl:"12h"}}]}]})).status).toBe("unsupported");
    for(const provider of ["anthropic","grok","google"] as const) {
      const model=provider==="anthropic"?"claude-sonnet-5-5":provider==="grok"?"grok-4.7":"gemini-2.5-pro";
      const endpoint=provider==="anthropic"?"/v1/messages":provider==="grok"?"/v1/chat/completions":"/v1beta/models/gemini-2.5-pro:generateContent";
      const request=prepareStandaloneRequest(provider,model,endpoint,{model,messages:[{role:"user",content:"hi"}],prompt_cache_key:"valid",prompt_cache_retention:"24h"});expect(estimatePreparedRequest(request).status).toBe("unsupported");
    }
    const modern=prepareStandaloneRequest("openai","gpt-6.1-sol","/v1/responses",{model:"gpt-6.1-sol",input:"Hi",...openAiCacheSettings("gpt-6.1-sol","valid-key")});expect(estimatePreparedRequest(modern).status).toBe("unsupported");
  });
});
describe("native client functions and bounded Claude reasoning",()=>{
  const schema={type:"object",properties:{query:{type:"string",description:"Read the user's local file"}},required:["query"]};
  const definition={name:"read_file",description:"Read a local file",parameters:schema};
  const resultText="The complete result of the local function.";
  it("counts exact schemas and OpenAI chat function calls/results as token input",()=>{
    const tools=[{type:"function",function:definition}];
    const initial=chat({tools});const first=estimatePreparedRequest(initial);
    expect(first.status).toBe("estimated");expect(first.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(first.inputTokens-estimatePreparedRequest(chat()).inputTokens).toBe(Buffer.byteLength(canonicalJson(tools[0]))+1024);
    const continuation=chat({tools,messages:[{role:"user",content:"Read it"},{role:"assistant",content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"read_file",arguments:'{"query":"report"}'}}]},{role:"tool",tool_call_id:"call_1",content:resultText}]});
    expect(estimatePreparedRequest(continuation).status).toBe("estimated");expect(continuation.hash).not.toBe(initial.hash);
    const expanded=chat({tools:[{type:"function",function:{...definition,description:"x".repeat(3000)}}]});
    expect(estimatePreparedRequest(expanded).inputTokens-first.inputTokens).toBe(3000-definition.description.length);
    expect(actualCostFromUsage(continuation,{inputTokens:2000,outputTokens:50}).actualMicrousd).toBe("5500");
  });
  it("supports actual OpenAI Responses function items and preserved output messages",()=>{
    const tools=[{type:"function",...definition,strict:false}];
    const request=prepareStandaloneRequest("openai","gpt-5.4","/v1/responses",{model:"gpt-5.4",instructions:"use local files",tools,max_output_tokens:4096,input:[{role:"user",content:"Read report"},{type:"reasoning",id:"rs_1",summary:[]},{type:"function_call",id:"fc_1",call_id:"call_1",name:"read_file",arguments:'{"query":"report"}',status:"completed"},{type:"function_call_output",call_id:"call_1",output:resultText},{type:"message",id:"msg1",role:"assistant",status:"completed",content:[{type:"output_text",text:"Result noted",annotations:[],logprobs:[]}]}]});
    expect(estimatePreparedRequest(request).status).toBe("estimated");
    const bad=prepareStandaloneRequest("openai","gpt-5.4","/v1/responses",{...request.payload,input:[{type:"function_call_output",call_id:"call_1",output:resultText,unknownBillingMode:"premium"}]});
    expect(estimatePreparedRequest(bad).status).toBe("unsupported");
  });
  it("prices Anthropic client tool_use/tool_result without inventing a server tool fee",()=>{
    const request=prepareStandaloneRequest("anthropic","claude-sonnet-5-5","/v1/messages",{model:"claude-sonnet-5-5",max_tokens:4096,tools:[{name:definition.name,description:definition.description,input_schema:schema}],messages:[{role:"user",content:"Read report"},{role:"assistant",content:[{type:"thinking",thinking:"",signature:"opaque-preserved-signature"},{type:"tool_use",id:"toolu1",name:"read_file",input:{query:"report",data:{type:"input_audio",payload:"ordinary JSON data"}}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"toolu1",content:[{type:"text",text:resultText}],is_error:false}]}]});
    expect(estimatePreparedRequest(request).status).toBe("estimated");
    expect(estimatePreparedRequest(request).assumptions.join(" ")).toContain("no provider-hosted tool fee");
    const bad=prepareStandaloneRequest("anthropic","claude-sonnet-5-5","/v1/messages",{...request.payload,messages:[{role:"user",content:[{type:"tool_result",tool_use_id:"toolu1",content:resultText,cache_control:{type:"ephemeral"}}]}]});expect(estimatePreparedRequest(bad).status).toBe("unsupported");
  });
  it("supports Gemini functionDeclarations, continuation signatures and responseJsonSchema",()=>{
    const request=prepareStandaloneRequest("google","gemini-2.5-pro","/v1beta/models/gemini-2.5-pro:generateContent",{systemInstruction:{parts:[{text:"local tool"}]},tools:[{functionDeclarations:[{name:definition.name,description:definition.description,parametersJsonSchema:schema}]}],toolConfig:{functionCallingConfig:{mode:"AUTO"}},generationConfig:{maxOutputTokens:4096,responseMimeType:"application/json",responseJsonSchema:schema},contents:[{role:"user",parts:[{text:"Read report"}]},{role:"model",parts:[{functionCall:{name:"read_file",args:{query:"report"}},thoughtSignature:"opaque-signature"}]},{role:"user",parts:[{functionResponse:{name:"read_file",response:{result:resultText,payload:{type:"image",data:"plain JSON"}}}}]}]});
    expect(estimatePreparedRequest(request).status).toBe("estimated");
    const noSchema=prepareStandaloneRequest("google",request.model,request.endpoint,{...request.payload,generationConfig:{maxOutputTokens:4096,responseMimeType:"application/json"}});
    expect(estimatePreparedRequest(request).inputTokens-estimatePreparedRequest(noSchema).inputTokens).toBe(Buffer.byteLength(canonicalJson(schema)));
    expect(estimatePreparedRequest(freezePreparedRequest("google","gemini-2.5-flash",request.endpoint,{...request.payload,model:"gemini-2.5-flash"})).status).toBe("unsupported");
  });
  it("supports bounded native Sonnet5.5 memory JSON configuration and counts hidden output once",()=>{
    const prepare=(extra:Record<string,unknown>)=>prepareStandaloneRequest("anthropic","claude-sonnet-5-5","/v1/messages",{model:"claude-sonnet-5-5",max_tokens:16384,system:"Edit durable memory",messages:[{role:"user",content:"Apply an evidence-backed correction"}],...extra});
    const request=prepare({thinking:{type:"between_tools"},output_config:{effort:"high",format:{type:"json_schema",schema}}});const estimate=estimatePreparedRequest(request);
    expect(estimate.status).toBe("estimated");expect(estimate.outputAllowance).toBe(16384);
    expect(estimate.inputTokens).toBeGreaterThan(estimatePreparedRequest(prepare({})).inputTokens+1024);
    expect(actualCostFromUsage(request,{inputTokens:1000,outputTokens:1000,thinkingTokens:800}).actualMicrousd).toBe("12000");
    for(const extra of [{thinking:{type:"between_tools",budget_tokens:1000}},{thinking:{type:"between_tools"},output_config:{effort:"max"}},{thinking:{type:"unknown"}},{output_config:{format:{type:"json_schema",schema},unknownBillingMode:true}}])expect(estimatePreparedRequest(prepare(extra)).status).toBe("unsupported");
    const legacy=prepareStandaloneRequest("anthropic","claude-sonnet-4-5","/v1/messages",{model:"claude-sonnet-4-5",max_tokens:4096,thinking:{type:"enabled",budget_tokens:1024},messages:[{role:"user",content:"Think"}]});expect(estimatePreparedRequest(legacy)).toMatchObject({status:"estimated",outputAllowance:4096});
    const reduced=reducePreparedRequest(legacy,{maxOutputTokens:2048});expect(estimatePreparedRequest(reduced.revised).status).toBe("estimated");
  });
  it("still fails closed on paid built-ins, mixed tool types and unknown continuation fields",()=>{
    for(const tools of [[{type:"web_search"}],[{type:"code_interpreter",container:{type:"auto"}}],[{type:"function",function:definition},{type:"file_search"}],[{type:"function",function:{...definition,billing_mode:"premium"}}]])expect(estimatePreparedRequest(chat({tools})).status).toBe("unsupported");
    const anthropic=prepareStandaloneRequest("anthropic","claude-sonnet-5-5","/v1/messages",{model:"claude-sonnet-5-5",max_tokens:4096,tools:[{type:"web_search_20260209",name:"web_search"}],messages:[{role:"user",content:"search"}]});expect(estimatePreparedRequest(anthropic).status).toBe("unsupported");
    const google=prepareStandaloneRequest("google","gemini-2.5-pro","/v1beta/models/gemini-2.5-pro:generateContent",{tools:[{functionDeclarations:[definition],googleSearch:{}}],contents:[{role:"user",parts:[{text:"search"}]}]});expect(estimatePreparedRequest(google).status).toBe("unsupported");
    expect(estimatePreparedRequest(chat({messages:[{role:"user",content:[{type:"image_url",image_url:{url:png(200,200)},billing_mode:"premium"}]}]})).status).toBe("unsupported");
  });
  it("reduction keeps native tool dependencies and arbitrary tool data/schema untouched",()=>{
    const messages=[{role:"user",content:"first"},{role:"assistant",content:null,tool_calls:[{id:"call1",type:"function",function:{name:"read_file",arguments:JSON.stringify({query:"[EPISODIC_MEMORY_LOG]\nUSER: keep1\nUSER: keep2\n[/EPISODIC_MEMORY_LOG]"})}}]},{role:"tool",tool_call_id:"call1",content:resultText},{role:"user",content:"finish"}];
    const original=chat({messages,tools:[{type:"function",function:definition}]});const reduced=reducePreparedRequest(original,{maxContextMessages:1,maxOutputTokens:1024});
    expect(reduced.revised.payload.messages).toEqual(messages);expect(reduced.revised.payload.tools).toEqual(original.payload.tools);expect(reduced.estimate.status).toBe("estimated");expect(reduced.tradeoffs.join(" ")).toContain("continuation dependencies");expect(reduced.revised.hash).not.toBe(original.hash);
  });
});
describe("deterministic reduce cost candidate",()=>{
  it("uses a reviewed cheaper model for short text instead of output-only savings",()=>{
    const original=chat({messages:[{role:"user",content:"Explain this briefly"}],max_tokens:4096});
    const candidate=reducePreparedRequest(original);
    expect(candidate.available).toBe(true);expect(candidate.revised.model).toBe("gpt-4o-mini");expect(candidate.revised.payload.model).toBe("gpt-4o-mini");
    expect(candidate.revised.payload.messages).toEqual(original.payload.messages);expect(candidate.originalHash).toBe(original.hash);expect(candidate.revised.hash).not.toBe(original.hash);
    expect(original.model).toBe("gpt-4o");expect(original.payload.model).toBe("gpt-4o");expect(candidate.changes).toContainEqual({kind:"model",path:"model",before:"gpt-4o",after:"gpt-4o-mini"});
    expect(candidate.tradeoffs.join(" ")).toContain("less accurate reasoning");expect(BigInt(candidate.estimate.reservationMicrousd!)).toBeLessThan(BigInt(estimatePreparedRequest(original).reservationMicrousd!));
    expect(reducePreparedRequest(original)).toEqual(candidate);
  });
  it("preserves premium Responses schema and reasoning effort in the deliberate lower-model proposal",()=>{
    for(const model of ["gpt-5.4-pro","gpt-5.4-pro-2026-03-05","gpt-5.5-pro","gpt-5.5-pro-2026-04-23"]) {
      const original=prepareStandaloneRequest("openai",model,"/v1/responses",{model,input:[{role:"user",content:"Analyze this plan"}],reasoning:{effort:"xhigh"},max_output_tokens:4096,stream:false});
      const candidate=reducePreparedRequest(original,{maxOutputTokens:4096});
      expect(candidate.available).toBe(true);expect(candidate.revised.model).toBe("gpt-5.4");expect(candidate.revised.endpoint).toBe(original.endpoint);expect(candidate.revised.payload.reasoning).toEqual(original.payload.reasoning);expect(candidate.revised.payload.input).toEqual(original.payload.input);expect(candidate.estimate.status).toBe("estimated");
      expect(BigInt(candidate.estimate.reservationMicrousd!)).toBeLessThan(BigInt(estimatePreparedRequest(original).reservationMicrousd!));
    }
  });
  it("uses same-generation Claude Sonnet with supported adaptive thinking and JSON schema",()=>{
    const schema={type:"object",properties:{result:{type:"string"}},required:["result"]};
    const original=prepareStandaloneRequest("anthropic","claude-opus-5-5","/v1/messages",{model:"claude-opus-5-5",max_tokens:4096,thinking:{type:"adaptive"},output_config:{effort:"max",format:{type:"json_schema",schema}},messages:[{role:"user",content:"Summarize accurately"}]});
    const candidate=reducePreparedRequest(original,{maxOutputTokens:4096});expect(candidate.revised.model).toBe("claude-sonnet-5-5");expect(candidate.estimate.status).toBe("estimated");expect(candidate.revised.payload.output_config).toEqual(original.payload.output_config);expect(candidate.revised.payload.thinking).toEqual(original.payload.thinking);expect(candidate.available).toBe(true);
  });
  it("refuses a cheaper model that lacks context and preserves model-bound opaque continuations",()=>{
    const large=chat({messages:[{role:"user",content:"x".repeat(140000)}],max_tokens:4096},"gpt-4.1");
    const candidate=reducePreparedRequest(large);expect(candidate.available).toBe(false);expect(candidate.revised.hash).toBe(large.hash);expect(candidate.changes).toEqual([]);expect(candidate.estimate.reservationMicrousd).toBe(estimatePreparedRequest(large).reservationMicrousd);
    const opaque=prepareStandaloneRequest("anthropic","claude-opus-5-5","/v1/messages",{model:"claude-opus-5-5",max_tokens:4096,messages:[{role:"assistant",content:[{type:"thinking",thinking:"",signature:"model-bound-state"}]},{role:"user",content:"Continue"}]});
    const blocked=reducePreparedRequest(opaque);expect(blocked.available).toBe(false);expect(blocked.revised.hash).toBe(opaque.hash);
  });
  it("returns no lower quote for an already-cheapest short request even with a reducible output cap",()=>{
    const original=chat({max_tokens:4096},"gpt-4o-mini"),candidate=reducePreparedRequest(original);
    expect(candidate.available).toBe(false);expect(candidate.revised.hash).toBe(original.hash);expect(candidate.revised.payload.max_tokens).toBe(4096);expect(candidate.changes).toEqual([]);expect(candidate.tradeoffs.join(" ")).toContain("No smaller supported proposal");
  });
  it("creates an independent fresh hash and estimate and preserves the final user message",()=>{
    const prepared=chat({messages:[{role:"system",content:"instructions"},...Array.from({length:8},(_,i)=>({role:i%2?"assistant":"user",content:`context ${i}`})),{role:"user",content:"current question"}],max_tokens:4096});
    const original=prepared.serializedBody;const revised=reducePreparedRequest(prepared,{maxContextMessages:2,maxOutputTokens:1000});
    expect(revised.revised.hash).not.toBe(prepared.hash);expect(revised.revised.payload.messages).toEqual([{role:"system",content:"instructions"},{role:"assistant",content:"context 7"},{role:"user",content:"current question"}]);
    expect(prepared.serializedBody).toBe(original);expect(BigInt(revised.estimate.reservationMicrousd!)).toBeLessThan(BigInt(estimatePreparedRequest(prepared).reservationMicrousd!));
    expect(reducePreparedRequest(prepared,{maxContextMessages:2,maxOutputTokens:1000})).toEqual(revised);expect(revised.tradeoffs.length).toBeGreaterThan(0);
  });
  it("deduplicates images, caps selection, lowers applicable detail and records tradeoffs",()=>{
    const image={type:"image_url",image_url:{url:png(1024,1024),detail:"high"}};
    const original=chat({messages:[{role:"user",content:[{type:"text",text:"review"},image,image,{type:"image_url",image_url:{url:png(200,200),detail:"high"}}]}]});
    const candidate=reducePreparedRequest(original,{maxImages:1});
    const content=((candidate.revised.payload.messages as JsonObject[])[0].content as JsonObject[]);
    expect(content).toHaveLength(2);expect((content[1].image_url as JsonObject).detail).toBe("low");expect(candidate.estimate.imageTokens).toBe(85);expect(candidate.changes.map(c=>c.kind)).toContain("duplicate");
    expect(estimatePreparedRequest(original).imageTokens).toBeGreaterThan(candidate.estimate.imageTokens);
  });
  it("reduces adapter-embedded episodic history without changing instructions",()=>{
    const request=chat({messages:[{role:"system",content:"Identity\n[EPISODIC_MEMORY_LOG]\nUSER: a\nASSISTANT: b\nUSER: c\n[/EPISODIC_MEMORY_LOG]\nKeep rules"},{role:"user",content:"current"}]});
    const reduced=reducePreparedRequest(request,{maxContextMessages:1});expect(reduced.revised.serializedBody).toContain("Identity");expect(reduced.revised.serializedBody).toContain("Keep rules");expect(reduced.revised.serializedBody).not.toContain("USER: a");expect(request.serializedBody).toContain("USER: a");
  });
  it("never guesses a price or changes a model to make an unsupported revision admissible",()=>{
    const result=reducePreparedRequest(chat({},"unknown"));expect(result.revised.model).toBe("unknown");expect(result.estimate.status).toBe("unsupported");
  });
});
import type { JsonObject } from "../lib/standalone-accounting/estimate";
