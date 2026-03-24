declare const process: { env: Record<string, string | undefined> };

type QueryResult<T> = Promise<{ data: T; error: { message: string } | null }>;

type Filter = { type: "eq" | "in"; field: string; value: unknown };
type Sort = { field: string; ascending: boolean };

class PostgrestQuery {
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private rowLimit: number | null = null;
  private selectedColumns = "*";

  constructor(private readonly config: { url: string; key: string }, private readonly table: string) {}

  select(columns = "*") {
    this.selectedColumns = columns;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ type: "eq", field, value });
    return this;
  }

  in(field: string, values: unknown[]) {
    this.filters.push({ type: "in", field, value: values });
    return this;
  }

  order(field: string, options: { ascending: boolean }) {
    this.sorts.push({ field, ascending: options.ascending });
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  returns<T>() {
    return this.execute<T[]>("GET");
  }

  maybeSingle<T>() {
    return this.execute<T | null>("GET", undefined, { single: true, allowEmpty: true });
  }

  single<T>() {
    return this.execute<T>("GET", undefined, { single: true, allowEmpty: false });
  }

  upsert(payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) {
    return {
      select: (columns = "*") => ({
        single: <T>() =>
          this.execute<T>("POST", payload, {
            select: columns,
            prefer: "resolution=merge-duplicates",
            onConflict: options?.onConflict,
            single: true,
            allowEmpty: false,
          }),
      }),
      then: (onfulfilled: (v: { data: null; error: { message: string } | null }) => unknown) =>
        this.execute<null>("POST", payload, {
          prefer: "resolution=merge-duplicates",
          onConflict: options?.onConflict,
          allowEmpty: true,
        }).then(onfulfilled),
    };
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
    return {
      select: (columns = "*") => ({
        single: <T>() =>
          this.execute<T>("POST", payload, {
            select: columns,
            single: true,
            allowEmpty: false,
          }),
      }),
    };
  }

  update(payload: Record<string, unknown>) {
    return this.execute<null>("PATCH", payload, { allowEmpty: true });
  }

  delete() {
    return this.execute<null>("DELETE", undefined, { allowEmpty: true });
  }



  then<TResult1 = { data: unknown[]; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[]; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute<unknown[]>("GET").then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
  private buildUrl(selectOverride?: string): string {
    const url = new URL(`${this.config.url}/rest/v1/${this.table}`);
    url.searchParams.set("select", selectOverride ?? this.selectedColumns);

    for (const filter of this.filters) {
      if (filter.type === "eq") {
        url.searchParams.set(filter.field, `eq.${encodeURIComponent(String(filter.value))}`);
      } else {
        const encodedValues = (filter.value as unknown[]).map((value) => `"${String(value)}"`).join(",");
        url.searchParams.set(filter.field, `in.(${encodedValues})`);
      }
    }

    if (this.sorts.length) {
      url.searchParams.set(
        "order",
        this.sorts.map((sort) => `${sort.field}.${sort.ascending ? "asc" : "desc"}`).join(",")
      );
    }

    if (this.rowLimit !== null) {
      url.searchParams.set("limit", String(this.rowLimit));
    }

    return url.toString();
  }

  private async execute<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
    options?: { select?: string; prefer?: string; single?: boolean; allowEmpty?: boolean; onConflict?: string }
  ): QueryResult<T> {
    try {
      let requestUrl = this.buildUrl(options?.select);
      if (options?.onConflict) {
        const url = new URL(requestUrl);
        url.searchParams.set("on_conflict", options.onConflict);
        requestUrl = url.toString();
      }

      const response = await fetch(requestUrl, {
        method,
        headers: {
          apikey: this.config.key,
          Authorization: `Bearer ${this.config.key}`,
          "Content-Type": "application/json",
          ...(options?.single ? { Accept: "application/vnd.pgrst.object+json" } : {}),
          ...(options?.prefer ? { Prefer: options.prefer } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });

      if (response.status === 406 && options?.allowEmpty) {
        return { data: null as T, error: null };
      }

      if (!response.ok) {
        const errorBody = await response.text();
        return { data: null as T, error: { message: errorBody || response.statusText } };
      }

      if (response.status === 204) {
        return { data: null as T, error: null };
      }

      const payload = (await response.json()) as T;
      return { data: payload, error: null };
    } catch (error) {
      return { data: null as T, error: { message: error instanceof Error ? error.message : "Supabase request failed" } };
    }
  }
}

class PostgrestClient {
  constructor(private readonly config: { url: string; key: string }) {}

  from(table: string) {
    return new PostgrestQuery(this.config, table);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __KATIE_SUPABASE_ADMIN_CLIENT__: PostgrestClient | undefined;
}

let cachedClient: PostgrestClient | null = null;

function requireEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

export function getSupabaseAdminClient() {
  if (globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__) {
    return globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
  }

  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = new PostgrestClient({
    url: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    key: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });

  return cachedClient;
}
