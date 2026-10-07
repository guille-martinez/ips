import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const metabase = stubConnector("metabase", "Metabase", ["METABASE_URL", "METABASE_API_KEY"]);
