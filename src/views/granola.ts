import type { SourceView } from "./types";
import { count, rows, sinceHours, toView } from "./helpers";

export const granolaView: SourceView = {
  source: "granola",
  title: "Granola",
  tile: () => ({
    stats: [
      { label: "meetings 7d", value: count("granola", sinceHours(24 * 7)) },
      { label: "30d", value: count("granola", sinceHours(24 * 30)) },
    ],
    items: rows("granola").map((r) => toView(r)),
  }),
};
