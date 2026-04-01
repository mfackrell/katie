import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateMetadata } from "../lib/router/model-intent";
import { deriveCostTierFromPricing } from "../lib/router/model-pricing/cost-tier";
import { refreshModelPricing } from "../lib/router/model-pricing-refresh";
import { parsePricingPairsFromHtml } from "../lib/router/model-pricing/sources/shared";

function setMockPricingRows(rows: Array<Record<string, unknown>>) {
  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: unknown }).__KATIE_SUPABASE_ADMIN_CLIENT__ = {
    from() {
      return {
        select() {
          return {
            returns: async () => ({ data: rows, error: null })
          };
        }
      };
    }
  };
}

test("cost tier derives from persisted numeric pricing instead of name regex", async () => {
  setMockPricingRows([
    {
      provider_name: "anthropic",
      model_id: "claude-4.5-sonnet",
      input_cost_per_1m: 0.2,
      output_cost_per_1m: 0.2,
      cached_input_cost_per_1m: null,
      cached_output_cost_per_1m: null,
      supports_web_search: null,
      supports_vision: null,
      supports_video: null,
      supports_image_generation: null,
      reasoning_depth_tier: null,
      speed_tier: null,
      cost_tier: null,
      pricing_status: "complete",
      source: "test",
      source_url: null,
      source_updated_at: null,
      refreshed_at: new Date().toISOString(),
      is_active: true
    }
  ]);

  const metadata = await buildCandidateMetadata("anthropic", "claude-4.5-sonnet", "assistant-reflection");
  assert.equal(metadata.cost_tier, "low");
});

test("heuristic cost fallback only applies when persisted pricing is missing", async () => {
  setMockPricingRows([]);
  const metadata = await buildCandidateMetadata("google", "gemini-3.1-flash", "general-text");
  assert.equal(metadata.cost_tier, "low");
});

test("router candidate metadata still builds when pricing store is unavailable", async () => {
  (globalThis as { __KATIE_SUPABASE_ADMIN_CLIENT__?: unknown }).__KATIE_SUPABASE_ADMIN_CLIENT__ = {
    from() {
      throw new Error("store offline");
    }
  };

  const metadata = await buildCandidateMetadata("openai", "o3-pro", "technical-debugging");
  assert.equal(metadata.cost_tier, "high");
});

test("refresh orchestration upserts rows and marks stale models inactive", async () => {
  const upserted: Array<Record<string, unknown>> = [];
  const markedInactive: Array<{ provider: string; models: string[] }> = [];

  const stats = await refreshModelPricing({
    discoverModelsByProvider: async () => ({
      openai: ["gpt-4o", "gpt-5"],
      google: [],
      grok: [],
      anthropic: []
    }),
    adapters: [
      {
        provider: "openai",
        run: async () => ({
          providerName: "openai",
          source: "test",
          sourceUrl: "https://example.com",
          sourceUpdatedAt: null,
          rows: [
            {
              modelId: "gpt-4o",
              inputCostPer1M: 2,
              outputCostPer1M: 8,
              cachedInputCostPer1M: null,
              cachedOutputCostPer1M: null,
              supportsWebSearch: true,
              supportsVision: true,
              supportsVideo: null,
              supportsImageGeneration: false,
              reasoningDepthTier: "medium",
              speedTier: "medium"
            }
          ]
        })
      }
    ],
    upsert: async (rows) => {
      upserted.push(...rows);
      return rows.length;
    },
    markInactive: async (provider, models) => {
      markedInactive.push({ provider, models });
      return 1;
    }
  });

  assert.equal(stats.total_rows_upserted, 2);
  assert.equal(stats.total_rows_marked_inactive, 1);
  assert.equal(stats.total_rows_complete, 1);
  assert.equal(stats.total_rows_metadata_only, 1);
  assert.equal(stats.total_rows_failed, 0);
  assert.equal(upserted.length, 2);
  assert.deepEqual(markedInactive[0], { provider: "openai", models: ["gpt-4o", "gpt-5"] });
});

test("refresh marks adapter failures as failed rows", async () => {
  const upserted: Array<Record<string, unknown>> = [];

  const stats = await refreshModelPricing({
    discoverModelsByProvider: async () => ({
      openai: ["gpt-5"],
      google: [],
      grok: [],
      anthropic: []
    }),
    adapters: [
      {
        provider: "openai",
        run: async () => {
          throw new Error("Pricing source request failed (403)");
        }
      }
    ],
    upsert: async (rows) => {
      upserted.push(...rows);
      return rows.length;
    },
    markInactive: async () => 0
  });

  assert.equal(stats.total_rows_failed, 1);
  assert.equal(stats.total_rows_complete, 0);
  assert.equal(upserted[0]?.pricing_status, "failed");
  assert.equal(upserted[0]?.cost_tier, null);
});

test("metadata-only pricing rows never assign fake cost_tier", async () => {
  const upserted: Array<Record<string, unknown>> = [];
  await refreshModelPricing({
    discoverModelsByProvider: async () => ({
      openai: ["gpt-4.1-mini"],
      google: [],
      grok: [],
      anthropic: []
    }),
    adapters: [
      {
        provider: "openai",
        run: async () => ({
          providerName: "openai",
          source: "test",
          sourceUrl: "https://example.com",
          sourceUpdatedAt: null,
          rows: []
        })
      }
    ],
    upsert: async (rows) => {
      upserted.push(...rows);
      return rows.length;
    },
    markInactive: async () => 0
  });

  assert.equal(upserted[0]?.pricing_status, "metadata_only");
  assert.equal(upserted[0]?.cost_tier, null);
});

test("router fallback ignores metadata-only pricing rows", async () => {
  setMockPricingRows([
    {
      provider_name: "openai",
      model_id: "gpt-5",
      input_cost_per_1m: null,
      output_cost_per_1m: null,
      cached_input_cost_per_1m: null,
      cached_output_cost_per_1m: null,
      supports_web_search: null,
      supports_vision: null,
      supports_video: null,
      supports_image_generation: null,
      reasoning_depth_tier: null,
      speed_tier: null,
      cost_tier: null,
      pricing_status: "metadata_only",
      source: "test",
      source_url: null,
      source_updated_at: null,
      refreshed_at: new Date().toISOString(),
      is_active: true
    }
  ]);

  const metadata = await buildCandidateMetadata("openai", "gpt-5", "technical-debugging");
  assert.equal(metadata.cost_tier, "medium");
});

test("adapter html parsing normalizes model ids and numeric costs", async () => {
  const rows = parsePricingPairsFromHtml(`
    <table>
      <tr><td>GPT-4O</td><td>$2.50 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
      <tr><td>claude-4.5-sonnet</td><td>$3 / 1M</td><td>$15 / 1M</td></tr>
    </table>
  `);

  assert.equal(rows[0]?.modelId, "gpt-4o");
  assert.equal(rows[0]?.inputCostPer1M, 2.5);
  assert.equal(rows[1]?.outputCostPer1M, 15);
});

test("cost tier thresholds are centralized", async () => {
  assert.equal(deriveCostTierFromPricing(0.1, 0.2), "low");
  assert.equal(deriveCostTierFromPricing(2, 3), "medium");
  assert.equal(deriveCostTierFromPricing(10, 20), "high");
});
