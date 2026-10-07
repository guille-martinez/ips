import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const attio = stubConnector("attio", "Attio", ["ATTIO_API_KEY"]);
