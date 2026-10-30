import { deepFreeze } from './pricing';

/** Reviewed infrastructure exposure, not a token price or an exact monetary receipt.
 * Only the existing approved Qwen endpoint and bounded still-image payload qualify.
 * A version change requires a new policy and a new quote. */
export const QWEN_STILL_POLICY = deepFreeze({
  version: 'standalone-runpod-qwen-still-v2',
  provider: 'runpod',
  model: 'Qwen/Qwen3-VL-8B-Instruct',
  endpointId: 'yafwsm98e8m9lv',
  endpoint: '/v2/yafwsm98e8m9lv/run',
  reservationMicrousd: '20000',
  costKind: 'estimated_infrastructure',
  maxImageCharacters: 8_000_000,
  maxQuestionCharacters: 8192,
  maxOutputTokens: 4096,
  executionTimeoutMs: 60_000,
  ttlMs: 900_000,
  maximumImagesPerRequest: 5,
  currency: 'USD',
  isCeiling: false,
});
