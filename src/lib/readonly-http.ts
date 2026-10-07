/**
 * The only way connectors talk to external APIs. v1 is read-only, so this client
 * exposes no PUT/PATCH/DELETE at all, and only allows POST for endpoints that are
 * explicitly allow-listed as reads (e.g. Notion search, Attio record queries) or
 * GraphQL queries (mutations/subscriptions are rejected before the request is sent).
 *
 * Errors never include request headers, so tokens can't leak into logs or sync_state.
 */

export class ReadOnlyViolation extends Error {}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export type ReadOnlyClientOptions = {
  baseUrl: string;
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  /** Path patterns where POST is a read (search/query endpoints). */
  readPosts?: RegExp[];
  /** Injected for tests (fixtures). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type ReadOnlyClient = {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  postRead<T = unknown>(path: string, body: unknown): Promise<T>;
  graphql<T = unknown>(path: string, query: string, variables?: Record<string, unknown>): Promise<T>;
};

export function assertGraphqlQuery(query: string): void {
  const stripped = query.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""/g, "").replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/\b(mutation|subscription)\b/.test(stripped)) {
    throw new ReadOnlyViolation("GraphQL mutations and subscriptions are not allowed in v1");
  }
}

export function createReadOnlyClient(opts: ReadOnlyClientOptions): ReadOnlyClient {
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(method: "GET" | "POST", path: string, query?: Query, body?: unknown): Promise<T> {
    const url = new URL(path, opts.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", ...(await opts.headers()) };
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 429 && attempt < 3) {
        const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt * 2);
        await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new HttpError(res.status, `${method} ${url.pathname} → ${res.status}: ${text}`);
      }
      return (await res.json()) as T;
    }
  }

  return {
    get: (path, query) => request("GET", path, query),
    postRead(path, body) {
      const pathname = new URL(path, opts.baseUrl).pathname;
      if (!opts.readPosts?.some((re) => re.test(pathname))) {
        throw new ReadOnlyViolation(`POST ${pathname} is not an allow-listed read endpoint`);
      }
      return request("POST", path, undefined, body);
    },
    async graphql(path, query, variables) {
      assertGraphqlQuery(query);
      const res = await request<{ data?: unknown; errors?: { message: string }[] }>("POST", path, undefined, { query, variables });
      if (res.errors?.length) throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
      return res.data as never;
    },
  };
}
