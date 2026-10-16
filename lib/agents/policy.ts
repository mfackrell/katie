import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

export const agentConfigSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(12000),
  research: z.boolean(), attachments: z.literal(false), development: z.boolean(),
  reviewMode: z.enum(["always", "adaptive"]),
  maxActiveTasks: z.number().int().min(1).max(4),
  maxInputChars: z.number().int().min(100).max(16000),
}).strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentTask = {
  id: string; agent_id: string; actor_id: string; chat_id: string;
  snapshot: AgentConfig; definition_version: number; kind: "general" | "development";
  initial_input: string; input: string; repository_id: string | null; repository_full_name: string | null; request_id: string;
  status: string; details: string | null; external: Record<string, unknown>;
};
export type ManagedAgent = { id: string; actor_id: string; config: AgentConfig; version: number; archived: boolean };
const scope = new AsyncLocalStorage<AgentTask>();
export const runAgentTask = <T>(task: AgentTask | null, work: () => T): T => task ? scope.run(task, work) : work();
export const currentAgentTask = () => scope.getStore();
export function requireAgentResearch() {
  if (scope.getStore()?.snapshot.research === false) throw new Error("Live research is disabled for this task.");
}
