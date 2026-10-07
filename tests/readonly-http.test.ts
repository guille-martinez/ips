import { describe, expect, it, vi } from "vitest";
import { assertGraphqlQuery, createReadOnlyClient, ReadOnlyViolation } from "@/lib/readonly-http";

const ok = () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });

describe("read-only http client", () => {
  it("rejects GraphQL mutations and subscriptions", () => {
    expect(() => assertGraphqlQuery("mutation { issueCreate(input: {}) { success } }")).toThrow(ReadOnlyViolation);
    expect(() => assertGraphqlQuery("subscription { x }")).toThrow(ReadOnlyViolation);
    expect(() => assertGraphqlQuery('query { issues(filter: { title: { contains: "mutation" } }) { nodes { id } } }')).not.toThrow();
  });

  it("only allows POST to allow-listed read endpoints", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const c = createReadOnlyClient({ baseUrl: "https://api.example.com", headers: () => ({}), readPosts: [/^\/v1\/search$/], fetchImpl });
    await c.postRead("/v1/search", {});
    expect(() => c.postRead("/v1/pages", {})).toThrow(ReadOnlyViolation);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exposes no write methods", () => {
    const c = createReadOnlyClient({ baseUrl: "https://x", headers: () => ({}) });
    expect(Object.keys(c).sort()).toEqual(["get", "graphql", "postRead"]);
  });
});
