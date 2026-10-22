declare const process: { env: Record<string, string | undefined> };

type QueryResult<T> = Promise<{ data: T; error: { message: string } | null }>;

type Filter = { type: "eq" | "in" | "lt" | "is" | "or"; field: string; value: unknown };
type Sort = { field: string; ascending: boolean };

// A timed-out write/RPC can have committed on the server. Never replay it here.
// Reads are retried only for transport failures and transient gateway statuses.
const REQUEST_TIMEOUT_MS = 20000;
const READ_RETRIES = 1;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function boundedRequest(url: string, init: RequestInit, operation: string, retryRead = false): Promise<Response> {
  const method = init.method ?? 'GET';
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let status: number | undefined;
    let failure = 'none';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      status = response.status;
      if (retryRead && attempt < READ_RETRIES && [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status)) {
        failure = 'transient_http';
        await response.body?.cancel().catch(() => undefined);
      } else {
        return response;
      }
    } catch (error) {
      failure = controller.signal.aborted ? 'timeout' : 'transport';
      if (!retryRead || attempt >= READ_RETRIES) throw error;
    } finally {
      clearTimeout(timer);
      const elapsedMs = Math.round(performance.now() - started);
      if (failure !== 'none' || elapsedMs >= 1000 || (status !== undefined && status >= 400)) {
        console.warn('[Supabase HTTP]', { operation, method, status: status ?? null, elapsedMs, failure, attempt });
      }
    }
    await wait(100 * (attempt + 1));
  }
}

class PostgrestQuery {
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private rowLimit: number | null = null;
  private rowOffset: number | null = null;
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

  lt(field: string, value: unknown) {
    this.filters.push({ type: "lt", field, value });
    return this;
  }

  is(field: string, value: null | boolean) {
    this.filters.push({ type: "is", field, value });
    return this;
  }

  or(filters: string) {
    this.filters.push({ type: "or", field: "or", value: filters });
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

  range(from: number, to: number) {
    this.rowOffset = from;
    this.rowLimit = to - from + 1;
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
            prefer: "resolution=merge-duplicates,return=representation",
            onConflict: options?.onConflict,
            single: true,
            allowEmpty: false,
            expectRepresentation: true,
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
            prefer: "return=representation",
            single: true,
            allowEmpty: false,
            expectRepresentation: true,
          }),
      }),
      then: (onfulfilled: (v: { data: null; error: { message: string } | null }) => unknown) =>
        this.execute<null>("POST", payload, {
          allowEmpty: true,
        }).then(onfulfilled),
    };
  }

  update(payload: Record<string, unknown>) {
    return this.execute<null>("PATCH", payload, { allowEmpty: true });
  }

  updateReturning<T>(payload: Record<string, unknown>, columns = "*") {
    return this.execute<T[]>("PATCH", payload, {
      select: columns,
      prefer: "return=representation",
      expectRepresentation: true,
    });
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
      if (filter.type === "or") {
        url.searchParams.set("or", `(${String(filter.value)})`);
      } else if (filter.type === "eq" || filter.type === "lt" || filter.type === "is") {
        // URLSearchParams encodes once; pre-encoding leaves escaped timestamps
        // and other literal values in the filter received by PostgREST.
        url.searchParams.set(filter.field, `${filter.type}.${String(filter.value)}`);
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
    if (this.rowOffset !== null) {
      url.searchParams.set("offset", String(this.rowOffset));
    }

    return url.toString();
  }

  private async execute<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
    options?: {
      select?: string;
      prefer?: string;
      single?: boolean;
      allowEmpty?: boolean;
      onConflict?: string;
      expectRepresentation?: boolean;
    }
  ): QueryResult<T> {
    try {
      let requestUrl = this.buildUrl(options?.select);
      if (options?.onConflict) {
        const url = new URL(requestUrl);
        url.searchParams.set("on_conflict", options.onConflict);
        requestUrl = url.toString();
      }

      const response = await boundedRequest(requestUrl, {
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
      }, `table:${this.table}`, method === "GET");

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

      const rawBody = await response.text();
      const hasBody = rawBody.trim().length > 0;

      if (!hasBody) {
        if (options?.allowEmpty) {
          return { data: null as T, error: null };
        }

        if (options?.expectRepresentation) {
          return {
            data: null as T,
            error: {
              message: `Supabase returned an empty response body for ${method} ${this.table} when a representation was expected.`,
            },
          };
        }

        return { data: null as T, error: null };
      }

      let payload: T;
      try {
        payload = JSON.parse(rawBody) as T;
      } catch {
        return {
          data: null as T,
          error: {
            message: `Supabase returned a non-JSON response body for ${method} ${this.table}.`,
          },
        };
      }

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

  async rpc<T = unknown>(name: string, args: Record<string, unknown>): QueryResult<T> {
    try {
      const response = await boundedRequest(
        `${this.config.url}/rest/v1/rpc/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: {
            apikey: this.config.key,
            Authorization: `Bearer ${this.config.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          cache: "no-store",
        }, `rpc:${name}`,
      );
      if (!response.ok) {
        return { data: null as T, error: { message: await response.text() || response.statusText } };
      }
      // PostgREST returns 204 for void functions. A successful empty response
      // must not abort subsequent evidence writes by being parsed as JSON.
      if (response.status === 204) return { data: null as T, error: null };
      const rawBody = await response.text();
      if (!rawBody.trim()) return { data: null as T, error: null };
      try {
        return { data: JSON.parse(rawBody) as T, error: null };
      } catch {
        return { data: null as T, error: { message: "Supabase RPC returned a non-JSON response body." } };
      }
    } catch (error) {
      return {
        data: null as T,
        error: { message: error instanceof Error ? error.message : "Supabase RPC request failed" },
      };
    }
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
