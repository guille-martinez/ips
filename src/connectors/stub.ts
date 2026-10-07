import type { Source } from "@/db/schema";
import { requireEnv, type Connector } from "./types";

/** Placeholder until the real connector lands (phase 2: one agent + worktree per connector). */
export function stubConnector(source: Source, label: string, envVars: string[]): Connector {
  return {
    source,
    label,
    configured: () => requireEnv(...envVars),
    checkAuth: async () => ({ ok: false, error: "Connector not implemented yet" }),
    sync: async () => {
      throw new Error("Connector not implemented yet");
    },
  };
}
