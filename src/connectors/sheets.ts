import { googleApi, googleConfigured, type GoogleDeps } from "@/lib/google-auth";
import { ReadOnlyViolation } from "@/lib/readonly-http";
import type { Connector, NewItem } from "./types";

// The Superbrain sheet (tasks + readings). Small, so every run takes a full snapshot (no cursor).
// Reads ONLY the tabs in SUPERBRAIN_TABS, and never anything that looks like a passwords tab.

type ValuesResponse = { range: string; values?: string[][] };

export function allowedTabs(): string[] {
  return (process.env.SUPERBRAIN_TABS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function assertAllowed(tab: string) {
  if (!allowedTabs().includes(tab) || /pass(word)?/i.test(tab)) throw new ReadOnlyViolation(`Sheet tab "${tab}" is not allow-listed`);
}

export function makeSheets(deps: GoogleDeps = {}): Connector {
  const api = googleApi("https://sheets.googleapis.com", deps);
  const sheetId = () => encodeURIComponent(process.env.SUPERBRAIN_SHEET_ID ?? "");

  return {
    source: "sheets",
    label: "Superbrain sheet",
    configured: () => googleConfigured("SUPERBRAIN_SHEET_ID", "SUPERBRAIN_TABS"),

    async checkAuth() {
      // Tab titles only: no cell data, so nothing outside the allow-list is read.
      const s = await api.get<{ properties: { title: string }; sheets: { properties: { title: string } }[] }>(`/v4/spreadsheets/${sheetId()}`, {
        fields: "properties.title,sheets.properties.title",
      });
      const present = new Set(s.sheets.map((x) => x.properties.title));
      const missing = allowedTabs().filter((t) => !present.has(t));
      if (missing.length) return { ok: false, error: `"${s.properties.title}" has no tab named ${missing.join(", ")}` };
      return { ok: true, identity: `"${s.properties.title}", tabs ${allowedTabs().join(", ")}` };
    },

    async sync() {
      const items: NewItem[] = [];
      for (const tab of allowedTabs()) {
        assertAllowed(tab);
        const range = `'${tab.replace(/'/g, "''")}'`;
        const res = await api.get<ValuesResponse>(`/v4/spreadsheets/${sheetId()}/values/${encodeURIComponent(range)}`);
        items.push(...rowsToItems(tab, res.values ?? [], process.env.SUPERBRAIN_SHEET_ID ?? ""));
      }
      return { items, nextCursor: null, hasMore: false };
    },
  };
}

const norm = (s: string) => s.trim().toLowerCase();

/** First row is the header. Columns are matched by name, so reordering the sheet is fine. */
export function rowsToItems(tab: string, values: string[][], sheetId: string, today = new Date()): NewItem[] {
  const [header = [], ...rows] = values;
  const col = (...names: string[]) => header.findIndex((h) => names.includes(norm(h)));
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "") || null;
  const isReadings = norm(tab) === "readings";
  const c = {
    title: isReadings ? col("name", "title") : col("priority", "task", "title"),
    status: col("status"),
    deadline: col("deadline", "due", "due date"),
    owner: col("owner"),
    link: col("link", "url"),
  };
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  const todayIso = today.toISOString().slice(0, 10);
  const seen = new Set<string>();
  const out: NewItem[] = [];

  rows.forEach((row, i) => {
    const title = cell(row, c.title);
    if (!title) return;
    const rowNo = i + 2; // 1-based, after the header
    let externalId = `${tab}:${cell(row, 0) ?? `row${rowNo}`}`;
    if (seen.has(externalId)) externalId = `${externalId}#${rowNo}`;
    seen.add(externalId);

    const status = cell(row, c.status);
    const link = cell(row, c.link);
    if (isReadings) {
      out.push({
        externalId,
        kind: "record",
        title,
        url: link ?? sheetUrl,
        occurredAt: todayIso,
        raw: { tab: "Readings", status },
      });
      return;
    }
    const deadline = parseDate(cell(row, c.deadline));
    const owner = cell(row, c.owner);
    out.push({
      externalId,
      kind: "record",
      title,
      author: owner,
      url: link ?? sheetUrl,
      // Rows carry no timestamp: use the deadline, else the snapshot day.
      occurredAt: deadline ?? todayIso,
      raw: { tab, status, deadline, owner, link },
    });
  });
  return out;
}

/** The sheet uses D/M/YY (also accepts D/M/YYYY and ISO). Returns YYYY-MM-DD or null. */
export function parseDate(s: string | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export const sheets = makeSheets();
