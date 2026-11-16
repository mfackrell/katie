export const TASK4A_SUCCESSOR_ENVELOPE: Readonly<Record<string,string|number>>;
export function validateTask4aSuccessorEnvelope(envelope:unknown): typeof TASK4A_SUCCESSOR_ENVELOPE;
export function task4aSuccessorRequestCap(input:{approval:unknown;defaultCap:number}):number;
export function assertTask4aSuccessorRequest(input:{envelope:unknown;inputTokens:number;opaqueTokens?:number;outputTokens?:number}):number;
