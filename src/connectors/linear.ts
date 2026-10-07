import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const linear = stubConnector("linear", "Linear", ["LINEAR_API_KEY"]);
