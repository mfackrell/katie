// Type declarations for the benchmark-only JavaScript provider module.
// Keep the native response shape available to the calling mission worker.
export interface BenchmarkModelResponse {
  status?: string;
  usage?: {total_tokens?:number;input_tokens?:number;output_tokens?:number;inputTokens?:number;outputTokens?:number};
  [key:string]:any;
}
export function executeBenchmarkMissionProvider(args:{
 db:unknown;
 binding:unknown;
 missionId:string;
 baselineSha:string;
 requestId:string;
 model:string;
 maxInputTokens:number;
 maxOutputTokens:number;
 invoke:()=>Promise<BenchmarkModelResponse>;
}):Promise<BenchmarkModelResponse>;
