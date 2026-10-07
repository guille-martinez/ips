import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const gmail = stubConnector("gmail", "Gmail", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
