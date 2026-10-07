import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const calendar = stubConnector("calendar", "Google Calendar", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
