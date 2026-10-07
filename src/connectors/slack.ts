import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const slack = stubConnector("slack", "Slack", ["SLACK_USER_TOKEN"]);
