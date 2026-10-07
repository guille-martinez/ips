import { createReadOnlyClient } from "@/lib/readonly-http";
import { backfillSince, requireEnv, type Connector, type NewItem } from "./types";

// Linear GraphQL API with a personal API key: https://linear.app/developers/graphql
// Queries only; the read-only client rejects mutations before they're sent.

type User = { id: string; name: string; email: string | null; isMe: boolean };
export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  priorityLabel: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  state: { name: string; type: string };
  assignee: User | null;
  creator: User | null;
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  parent: { identifier: string } | null;
  labels: { nodes: { name: string }[] };
};
type IssuesResponse = { issues: { nodes: Issue[]; pageInfo: { hasNextPage: boolean } } };

const USER = "id name email isMe";
const ISSUES = `query Issues($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, orderBy: updatedAt, first: $first) {
    nodes {
      id identifier title description url priority priorityLabel dueDate
      createdAt updatedAt completedAt canceledAt
      state { name type }
      assignee { ${USER} }
      creator { ${USER} }
      team { id key name }
      project { id name }
      parent { identifier }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage }
  }
}`;

const PAGE_SIZE = 100;
const BODY_CAP = 20_000;

/**
 * `since` = high-water mark of updatedAt from the last finished pass.
 * While paging, `floor` = oldest updatedAt seen so far: orderBy updatedAt is newest-first, so each
 * page asks for issues at or below the floor instead of using Linear's `after` cursor. That way an
 * issue updated mid-pass moves out of the window rather than shifting page boundaries and making
 * us skip one. `strict` switches to `lt` if a whole page shared the floor (avoids looping on ties).
 */
type State = { since: string; floor?: string; strict?: boolean; maxSeen?: string };

export function makeLinear(fetchImpl?: typeof fetch): Connector {
  const api = createReadOnlyClient({
    baseUrl: "https://api.linear.app",
    // Personal API keys go in the header as-is (no "Bearer").
    headers: () => ({ authorization: process.env.LINEAR_API_KEY ?? "" }),
    fetchImpl,
  });

  return {
    source: "linear",
    label: "Linear",
    configured: () => requireEnv("LINEAR_API_KEY"),

    async checkAuth() {
      const res = await api.graphql<{ viewer: { name: string; email: string }; organization: { name: string } }>(
        "/graphql",
        "query { viewer { name email } organization { name } }",
      );
      return { ok: true, identity: `${res.viewer.email} on workspace ${res.organization.name}` };
    },

    async sync(cursor) {
      const state: State = cursor ? JSON.parse(cursor) : { since: backfillSince().toISOString() };
      const updatedAt: Record<string, string> = { gt: state.since };
      if (state.floor) updatedAt[state.strict ? "lt" : "lte"] = state.floor;

      const res = await api.graphql<IssuesResponse>("/graphql", ISSUES, { filter: { updatedAt }, first: PAGE_SIZE });
      const nodes = res.issues.nodes;

      let maxSeen = state.maxSeen ?? state.since;
      let minSeen: string | undefined;
      for (const n of nodes) {
        if (n.updatedAt > maxSeen) maxSeen = n.updatedAt;
        if (!minSeen || n.updatedAt < minSeen) minSeen = n.updatedAt;
      }

      const more = res.issues.pageInfo.hasNextPage && !!minSeen;
      const next: State = more
        ? { since: state.since, floor: minSeen, strict: minSeen === state.floor || undefined, maxSeen }
        : { since: maxSeen };
      return { items: nodes.map(toItem), nextCursor: JSON.stringify(next), hasMore: more };
    },
  };
}

function person(u: User | null) {
  return u ? { name: u.name, email: u.email ?? undefined } : null;
}

export function toItem(i: Issue): NewItem {
  const participants = [person(i.assignee), person(i.creator)].filter((p) => p !== null);
  const unique = participants.filter((p, idx) => participants.findIndex((q) => q.name === p.name && q.email === p.email) === idx);
  const desc = i.description?.trim();
  return {
    externalId: i.id,
    kind: "issue",
    threadKey: i.parent?.identifier ?? i.identifier, // sub-issues group with their parent
    author: i.creator?.name ?? null,
    participants: unique,
    title: `${i.identifier} ${i.title}`,
    bodyText: desc ? desc.slice(0, BODY_CAP) : null,
    url: i.url,
    occurredAt: i.createdAt,
    updatedAt: i.updatedAt,
    raw: i,
  };
}

export const linear = makeLinear();
