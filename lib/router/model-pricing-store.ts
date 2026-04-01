import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { ProviderName } from "@/lib/router/model-intent";
import type { ModelPricingRow, ModelPricingUpsertRow } from "@/lib/router/model-pricing/types";

type ModelPricingLookup = Map<string, ModelPricingRow>;

let cachedLookup: { expiresAt: number; data: ModelPricingLookup } | null = null;
let inflightLookup: Promise<ModelPricingLookup> | null = null;

function pricingKey(providerName: ProviderName, modelId: string): string {
  return `${providerName}:${modelId}`;
}

function normalizeRow(row: ModelPricingRow): ModelPricingRow {
  return {
    ...row,
    input_cost_per_1m: row.input_cost_per_1m === null ? null : Number(row.input_cost_per_1m),
    output_cost_per_1m: row.output_cost_per_1m === null ? null : Number(row.output_cost_per_1m),
    cached_input_cost_per_1m: row.cached_input_cost_per_1m === null ? null : Number(row.cached_input_cost_per_1m),
    cached_output_cost_per_1m: row.cached_output_cost_per_1m === null ? null : Number(row.cached_output_cost_per_1m)
  };
}

export function clearModelPricingCache() {
  cachedLookup = null;
  inflightLookup = null;
}

export async function getAllModelPricingRows(): Promise<ModelPricingRow[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("model_pricing")
    .select("provider_name,model_id,input_cost_per_1m,output_cost_per_1m,cached_input_cost_per_1m,cached_output_cost_per_1m,supports_web_search,supports_vision,supports_video,supports_image_generation,reasoning_depth_tier,speed_tier,cost_tier,source,source_url,source_updated_at,refreshed_at,is_active")
    .returns<ModelPricingRow>();

  if (error) {
    throw new Error(`Failed to list model pricing rows: ${error.message}`);
  }

  return (data ?? []).map((row) => normalizeRow(row));
}

export async function getModelPricingLookup(options?: { forceRefresh?: boolean; ttlMs?: number }): Promise<ModelPricingLookup> {
  const now = Date.now();
  const ttlMs = options?.ttlMs ?? 60_000;

  if (!options?.forceRefresh && cachedLookup && cachedLookup.expiresAt > now) {
    return cachedLookup.data;
  }

  if (inflightLookup) {
    return inflightLookup;
  }

  inflightLookup = getAllModelPricingRows()
    .then((rows) => {
      const map = new Map<string, ModelPricingRow>();
      for (const row of rows) {
        map.set(pricingKey(row.provider_name, row.model_id), row);
      }
      cachedLookup = { expiresAt: now + ttlMs, data: map };
      return map;
    })
    .finally(() => {
      inflightLookup = null;
    });

  return inflightLookup;
}

export async function getModelPricing(providerName: ProviderName, modelId: string): Promise<ModelPricingRow | null> {
  const lookup = await getModelPricingLookup();
  return lookup.get(pricingKey(providerName, modelId)) ?? lookup.get(pricingKey(providerName, modelId.toLowerCase())) ?? null;
}

export async function getAllActiveModelPricing(): Promise<ModelPricingRow[]> {
  const allRows = await getAllModelPricingRows();
  return allRows.filter((row) => row.is_active);
}

export async function upsertModelPricing(rows: ModelPricingUpsertRow[]): Promise<number> {
  if (!rows.length) {
    return 0;
  }

  const client = getSupabaseAdminClient();
  const payload = rows.map((row) => ({ ...row, is_active: row.is_active ?? true }));
  const { error } = await client.from("model_pricing").upsert(payload, { onConflict: "provider_name,model_id" });

  if (error) {
    throw new Error(`Failed to upsert model pricing rows: ${error.message}`);
  }

  clearModelPricingCache();
  return rows.length;
}

export async function markInactiveModelPricing(providerName: ProviderName, activeModelIds: string[]): Promise<number> {
  const client = getSupabaseAdminClient();
  const activeSet = new Set(activeModelIds);
  const { data, error } = await client
    .from("model_pricing")
    .select("provider_name,model_id,input_cost_per_1m,output_cost_per_1m,cached_input_cost_per_1m,cached_output_cost_per_1m,supports_web_search,supports_vision,supports_video,supports_image_generation,reasoning_depth_tier,speed_tier,cost_tier,source,source_url,source_updated_at,refreshed_at,is_active")
    .eq("provider_name", providerName)
    .eq("is_active", true)
    .returns<ModelPricingRow>();

  if (error) {
    throw new Error(`Failed to read active pricing rows for ${providerName}: ${error.message}`);
  }

  const staleRows = (data ?? []).filter((row) => !activeSet.has(row.model_id));
  if (!staleRows.length) {
    return 0;
  }

  const deactivatePayload = staleRows.map((row) => ({
    ...row,
    is_active: false
  }));
  const { error: updateError } = await client.from("model_pricing").upsert(deactivatePayload, {
    onConflict: "provider_name,model_id"
  });

  if (updateError) {
    throw new Error(`Failed to mark inactive pricing rows for ${providerName}: ${updateError.message}`);
  }

  clearModelPricingCache();
  return staleRows.length;
}
