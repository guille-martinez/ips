import { createReadOnlyClient } from "@/lib/readonly-http";
import type { Participant } from "@/db/schema";
import { backfillSince, requireEnv, type Connector, type NewItem } from "./types";

// Attio REST v2: https://docs.attio.com/rest-api
// Records have no updated_at and no "changed since" filter, so each run scans companies and
// deals in full (≈1k records, 500 per page) and emits only records whose newest attribute
// value is past the high-water mark. Notes have no documented ordering, so they're scanned
// too (50 per page) and filtered on created_at.
// Custom objects (products, carrier rate cards, carriers) are small and mapped generically:
// every set attribute becomes a "Title: value" line, with references shown by name.

type Actor = { type: string | null; id: string | null };
type Value = { active_from: string; created_by_actor?: Actor; attribute_type: string } & Record<string, unknown>;
export type AttioRecord = {
  id: { workspace_id: string; object_id: string; record_id: string };
  created_at: string;
  web_url?: string;
  values: Record<string, Value[]>;
};
export type AttioNote = {
  id: { workspace_id: string; note_id: string };
  parent_object: string;
  parent_record_id: string;
  title: string | null;
  content_plaintext: string | null;
  meeting_id: string | null;
  created_by_actor: Actor;
  created_at: string;
};
type Member = { id: { workspace_member_id: string }; first_name: string | null; last_name: string | null; email_address: string };
type Self = { active: boolean; workspace_name?: string; workspace_slug?: string; scope?: string };

// Order matters: an object's references resolve to names only if the target was scanned first.
const STEPS = ["companies", "deals", "products", "carrier_rate_cards", "carriers", "notes"] as const;
const CUSTOM = ["products", "carrier_rate_cards", "carriers"] as const;
type Custom = (typeof CUSTOM)[number];
/** The attribute holding each object's display name. */
const NAME_SLUG: Record<string, string> = {
  companies: "name",
  deals: "name",
  products: "product_name_3",
  carrier_rate_cards: "carrier_rate_card_name",
  carriers: "carrier_opportunity_name",
};
/** Shown as the record's status badge. */
const STATUS_SLUG: Partial<Record<Custom, string>> = { carriers: "carrier_status" };
const SKIP_SLUGS = new Set(["record_id", "created_at", "created_by"]);
const PAGE = { records: 500, notes: 50 };
const BODY_CAP = 20_000;
/** Deal stage → phase. Prospecting stages are open but not yet a real conversation. */
export function dealPhase(stage: string | null): "prospecting" | "active" | "won" | "lost" {
  if (!stage) return "prospecting";
  if (/lost|dead|churn/i.test(stage)) return "lost";
  if (/won|live/i.test(stage)) return "won";
  if (/lead|outreach/i.test(stage)) return "prospecting";
  return "active";
}
const SKEW_MS = 5 * 60_000;
/** Web app paths, as seen in real web_url values. Anything else is a custom object. */
const WEB_PATH: Record<string, (id: string) => string> = {
  companies: (id) => `company/${id}`,
  people: (id) => `person/${id}`,
  deals: (id) => `deals/record/${id}`,
};

/**
 * Cursor. `since` = high-water mark from the last complete pass (null on the first pass:
 * every deal, plus companies/notes changed since backfillSince()). One page per sync() call.
 */
type State = { since: string | null; step: number; offset: number; maxSeen: string; passStart?: string };

/** Lookups shared across the pages of one pass. Rebuilt at the start of every pass. */
export type Ctx = {
  slug: string;
  members: Map<string, { name: string; email: string }>;
  /** `${object}:${record_id}` → display name, filled as each object is scanned. */
  names: Map<string, string>;
  /** `${object}:${record_id}` → web_url, so notes link to their parent record. */
  urls: Map<string, string>;
  /** Custom object → attribute slug → title, for readable body text. */
  titles: Map<string, Map<string, string>>;
};
type Attribute = { api_slug: string; title: string };

export function makeAttio(fetchImpl?: typeof fetch): Connector {
  const api = createReadOnlyClient({
    baseUrl: "https://api.attio.com",
    headers: () => ({ authorization: `Bearer ${process.env.ATTIO_API_KEY}` }),
    readPosts: [/^\/v2\/objects\/[^/]+\/records\/query$/],
    fetchImpl,
  });
  let ctx: Ctx | null = null;

  async function loadCtx(): Promise<Ctx> {
    const [self, members, ...attrs] = await Promise.all([
      api.get<Self>("/v2/self"),
      api.get<{ data: Member[] }>("/v2/workspace_members"),
      ...CUSTOM.map((o) => api.get<{ data: Attribute[] }>(`/v2/objects/${o}/attributes`)),
    ]);
    return {
      slug: self.workspace_slug ?? "opereit",
      members: new Map(
        members.data.map((m) => [
          m.id.workspace_member_id,
          { name: [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email_address, email: m.email_address },
        ]),
      ),
      names: new Map(),
      urls: new Map(),
      titles: new Map(CUSTOM.map((o, i) => [o, new Map(attrs[i].data.map((a) => [a.api_slug, a.title.trim()]))])),
    };
  }

  return {
    source: "attio",
    label: "Attio",
    configured: () => requireEnv("ATTIO_API_KEY"),

    async checkAuth() {
      const self = await api.get<Self>("/v2/self");
      if (!self.active) return { ok: false, error: "Token is inactive or revoked" };
      return { ok: true, identity: `workspace ${self.workspace_name} (${self.scope ?? "no scopes"})` };
    },

    async sync(cursor) {
      const now = new Date().toISOString();
      const state: State = cursor ? JSON.parse(cursor) : { since: null, step: 0, offset: 0, maxSeen: "" };
      if (state.step >= STEPS.length) Object.assign(state, { step: 0, offset: 0, maxSeen: state.since ?? "" });
      if (state.step === 0 && state.offset === 0) state.passStart = now;
      if (!ctx || (state.step === 0 && state.offset === 0)) ctx = await loadCtx();
      const c = ctx;
      const step = STEPS[state.step];
      const backfill = backfillSince().toISOString();
      // On the first pass, deals and the small custom objects come in full (they're state, not
      // activity: the pipeline view needs every open deal). Companies and notes use the backfill.
      const threshold = state.since ?? (step === "companies" || step === "notes" ? backfill : "");

      const items: NewItem[] = [];
      let maxSeen = state.maxSeen;
      let pageLen: number;
      let limit: number;

      if (step === "notes") {
        limit = PAGE.notes;
        const res = await api.get<{ data: AttioNote[] }>("/v2/notes", { limit, offset: state.offset });
        pageLen = res.data.length;
        for (const n of res.data) {
          const at = iso(n.created_at);
          if (at > maxSeen) maxSeen = at;
          if (at > threshold) items.push(noteToItem(n, c));
        }
      } else {
        limit = PAGE.records;
        const res = await api.postRead<{ data: AttioRecord[] }>(`/v2/objects/${step}/records/query`, {
          limit,
          offset: state.offset,
          sorts: [{ attribute: "created_at", direction: "asc" }], // stable paging
        });
        pageLen = res.data.length;
        for (const r of res.data) {
          const name = text(r, NAME_SLUG[step]);
          if (name) c.names.set(`${step}:${r.id.record_id}`, name);
          if (r.web_url) c.urls.set(`${step}:${r.id.record_id}`, r.web_url);
          const at = lastChanged(r);
          if (at > maxSeen) maxSeen = at;
          if (at > threshold) {
            items.push(step === "deals" ? dealToItem(r, c) : step === "companies" ? companyToItem(r, c) : customToItem(step, r, c));
          }
        }
      }

      const next: State =
        pageLen === limit
          ? { ...state, offset: state.offset + limit, maxSeen }
          : { ...state, step: state.step + 1, offset: 0, maxSeen };
      const done = next.step >= STEPS.length;
      if (!done) return { items, nextCursor: JSON.stringify(next), hasMore: true };
      // A record edited mid-pass, after its page was read, must still count as new next pass:
      // so the mark never passes the start of this pass (minus clock skew).
      const ceiling = new Date(Date.parse(state.passStart ?? now) - SKEW_MS).toISOString();
      const since = maxSeen && maxSeen < ceiling ? maxSeen : ceiling;
      return { items, nextCursor: JSON.stringify({ since, step: STEPS.length, offset: 0, maxSeen: "" }), hasMore: false };
    },
  };
}

// ---------- mapping ----------

const iso = (t: string) => new Date(t).toISOString(); // Attio uses nanosecond precision

/** Newest user-visible change: latest active_from, ignoring interaction stats and system enrichment. */
export function lastChanged(r: AttioRecord): string {
  let max = iso(r.created_at);
  for (const vals of Object.values(r.values)) {
    for (const v of vals) {
      if (v.attribute_type === "interaction" || v.created_by_actor?.type === "system") continue;
      const at = iso(v.active_from);
      if (at > max) max = at;
    }
  }
  return max;
}

const first = (r: AttioRecord, slug: string) => r.values[slug]?.[0];
const text = (r: AttioRecord, slug: string) => (first(r, slug)?.value as string | undefined) ?? null;
const select = (r: AttioRecord, slug: string) => (first(r, slug)?.option as { title: string } | undefined)?.title ?? null;
const status = (r: AttioRecord, slug: string) => (first(r, slug)?.status as { title: string } | undefined)?.title ?? null;
const refId = (r: AttioRecord, slug: string) => (first(r, slug)?.target_record_id as string | undefined) ?? null;
const actorId = (r: AttioRecord, slug: string) => (first(r, slug)?.referenced_actor_id as string | undefined) ?? null;
const money = (r: AttioRecord, slug: string) => {
  const v = first(r, slug);
  return v ? { amount: v.currency_value as number, currency: (v.currency_code as string) ?? "EUR" } : null;
};

function recordUrl(c: Ctx, object: string, id: string, web?: string) {
  return web ?? `https://app.attio.com/${c.slug}/${WEB_PATH[object]?.(id) ?? `custom/${object}/record/${id}`}`;
}

function memberParticipant(c: Ctx, id: string | null): Participant[] {
  const m = id ? c.members.get(id) : undefined;
  return m ? [{ name: m.name, email: m.email }] : [];
}

const cap = (s: string) => (s.length > BODY_CAP ? s.slice(0, BODY_CAP) + "…" : s);

export function dealToItem(r: AttioRecord, c: Ctx): NewItem {
  const id = r.id.record_id;
  const stage = status(r, "stage");
  const ownerId = actorId(r, "owner");
  const owner = ownerId ? c.members.get(ownerId) : undefined;
  const acv = money(r, "estimated_deal_value");
  const closeDate = text(r, "expected_close_date");
  const companyId = refId(r, "associated_company");
  const company = companyId ? (c.names.get(`companies:${companyId}`) ?? null) : null;
  const lostReason = select(r, "lost_reason");
  const updated = lastChanged(r);
  const name = text(r, "name") ?? "(unnamed deal)";

  const facts = [
    stage && `Stage: ${stage}`,
    owner && `Owner: ${owner.name}`,
    company && `Company: ${company}`,
    acv && `ACV: ${acv.amount} ${acv.currency}`,
    closeDate && `Expected close: ${closeDate}`,
  ].filter(Boolean);
  const lost = lostReason ? `Lost reason: ${[lostReason, text(r, "lost_reason_details")].filter(Boolean).join(", ")}` : null;
  const body = [facts.join(" · "), text(r, "deal_summary"), lost].filter(Boolean).join("\n\n");

  return {
    externalId: `deals:${id}`,
    kind: "record",
    threadKey: `attio:deals:${id}`,
    author: owner?.name ?? null,
    participants: memberParticipant(c, ownerId),
    title: name,
    bodyText: cap(body) || null,
    url: recordUrl(c, "deals", id, r.web_url),
    occurredAt: updated,
    updatedAt: updated,
    raw: {
      ...r,
      ips: {
        object: "deals",
        name,
        stage,
        phase: dealPhase(stage),
        open: ["prospecting", "active"].includes(dealPhase(stage)),
        owner: owner?.name ?? null,
        close_date: closeDate,
        acv: acv?.amount ?? null,
        currency: acv?.currency ?? null,
        company,
        company_id: companyId,
        lost_reason: lostReason,
      },
    },
  };
}

export function companyToItem(r: AttioRecord, c: Ctx): NewItem {
  const id = r.id.record_id;
  const name = text(r, "name") ?? "(unnamed company)";
  const customerType = select(r, "customer_type");
  const domains = (r.values.domains ?? []).map((v) => v.domain as string).filter(Boolean);
  const deals = (r.values.associated_deals ?? []).length;
  const facts = [customerType, domains.join(", "), deals ? `${deals} deal${deals > 1 ? "s" : ""}` : null].filter(Boolean);
  const body = [facts.join(" · "), text(r, "description")].filter(Boolean).join("\n\n");
  const updated = lastChanged(r);
  return {
    externalId: `companies:${id}`,
    kind: "record",
    threadKey: `attio:companies:${id}`,
    author: null,
    participants: [],
    title: name,
    bodyText: cap(body) || null,
    url: recordUrl(c, "companies", id, r.web_url),
    occurredAt: updated,
    updatedAt: updated,
    raw: { ...r, ips: { object: "companies", name, customer_type: customerType, domains, deal_count: deals } },
  };
}

export function noteToItem(n: AttioNote, c: Ctx): NewItem {
  const author = n.created_by_actor.type === "workspace-member" && n.created_by_actor.id ? c.members.get(n.created_by_actor.id) : undefined;
  const parent = c.names.get(`${n.parent_object}:${n.parent_record_id}`);
  const at = iso(n.created_at);
  return {
    externalId: `notes:${n.id.note_id}`,
    kind: "note",
    threadKey: `attio:${n.parent_object}:${n.parent_record_id}`, // same key as the parent record
    author: author?.name ?? (n.created_by_actor.type === "app" ? "Attio app" : null),
    participants: memberParticipant(c, author ? n.created_by_actor.id : null),
    title: n.title || "(untitled note)",
    bodyText: n.content_plaintext ? cap(n.content_plaintext) : null,
    url: c.urls.get(`${n.parent_object}:${n.parent_record_id}`) ?? recordUrl(c, n.parent_object, n.parent_record_id),
    occurredAt: at,
    updatedAt: at,
    raw: { ...n, ips: { object: "notes", parent_object: n.parent_object, parent_name: parent ?? null } },
  };
}

/** Renders one attribute's current value(s) as text, or null if there's nothing worth showing. */
function render(vals: Value[], c: Ctx): string | null {
  const out = vals
    .map((v): string | null => {
      switch (v.attribute_type) {
        case "status":
          return (v.status as { title: string } | undefined)?.title ?? null;
        case "select":
          return (v.option as { title: string } | undefined)?.title ?? null;
        case "currency":
          return v.currency_value == null ? null : `${v.currency_value} ${v.currency_code ?? ""}`.trim();
        case "record-reference":
          return c.names.get(`${v.target_object}:${v.target_record_id}`) ?? null;
        case "actor-reference":
          return c.members.get(v.referenced_actor_id as string)?.name ?? null;
        case "checkbox":
          return v.value ? "yes" : "no";
        case "domain":
          return (v.domain as string) ?? null;
        case "email-address":
          return (v.email_address as string) ?? null;
        case "personal-name":
          return (v.full_name as string) ?? null;
        case "interaction":
        case "location":
          return null;
        default:
          return v.value == null ? null : String(v.value);
      }
    })
    .filter((x): x is string => !!x);
  return out.length ? out.join(", ") : null;
}

export function customToItem(object: Custom, r: AttioRecord, c: Ctx): NewItem {
  const id = r.id.record_id;
  const titles = c.titles.get(object);
  const name = text(r, NAME_SLUG[object]);
  const statusSlug = STATUS_SLUG[object];
  const stat = statusSlug ? status(r, statusSlug) : null;
  const lines: string[] = [];
  for (const [slug, vals] of Object.entries(r.values)) {
    if (SKIP_SLUGS.has(slug) || slug === NAME_SLUG[object]) continue;
    const v = render(vals, c);
    if (v) lines.push(`${titles?.get(slug) ?? slug}: ${v}`);
  }
  const ref = (slug: string) => {
    const v = first(r, slug);
    return v ? (c.names.get(`${v.target_object}:${v.target_record_id}`) ?? null) : null;
  };
  // Carrier opportunity names are just the carrier ("UPS"), so add the customer for context.
  const company = ref("company");
  const base = object === "carriers" ? (name ?? ref("carrier_name_3")) : name;
  const title =
    object === "carriers" && company && !base?.toLowerCase().includes(company.toLowerCase())
      ? [base, company].filter(Boolean).join(" · ")
      : base;
  const updated = lastChanged(r);
  return {
    externalId: `${object}:${id}`,
    kind: "record",
    threadKey: `attio:${object}:${id}`,
    author: null,
    participants: [],
    title: title ?? "(unnamed record)",
    bodyText: lines.length ? cap(lines.join("\n")) : null,
    url: recordUrl(c, object, id, r.web_url),
    occurredAt: updated,
    updatedAt: updated,
    raw: { ...r, ips: { object, name, status: stat, company, deal: ref("deal") } },
  };
}

export const attio = makeAttio();
