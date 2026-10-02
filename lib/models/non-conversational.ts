// These model families do not produce conversational text through the chat adapters.
// Enforce this even when discovered registry rows incorrectly advertise text support.
export function isNonConversationalModel(modelId: string): boolean {
  return /(?:^|[-_.])(lyria|veo|sora|music|tts|transcribe|transcription|whisper|embedding|embeddings|moderation|audio-gen|speech-gen|voice-gen|lip-sync)(?:$|[-_.])/i.test(modelId);
}
