import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
// Reads ONLY the tabs listed in SUPERBRAIN_TABS (never the "Passwords" tab).
export const sheets = stubConnector("sheets", "Superbrain sheet", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SUPERBRAIN_SHEET_ID"]);
