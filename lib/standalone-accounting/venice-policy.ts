import { deepFreeze } from './pricing';

/** Separate, reviewed vision-only Venice infrastructure reservation.
 * $0.10 is held per attempt, not asserted as exact usage or a guaranteed bill.
 * Published token prices and model vision capability must also match at free
 * preflight discovery before each first paid dispatch.
 */
export const VENICE_STILL_POLICY = deepFreeze({
  version: 'standalone-venice-dolphin-vision-v1',
  provider: 'venice',
  model: 'venice-uncensored-1-2',
  endpoint: '/api/v1/chat/completions',
  reservationMicrousd: '100000',
  inputUsdPerMillion: 0.20,
  outputUsdPerMillion: 0.90,
  maxImageCharacters: 8_000_000,
  maxPromptCharacters: 8192,
  maxOutputTokens: 4096,
  maxContextTokens: 128000,
  timeoutMs: 45_000,
  maxResponseCharacters: 300_000,
  maxDescriptionCharacters: 20_000,
});
