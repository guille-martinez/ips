import { stubConnector } from "./stub";

// TODO(phase 2): replace with the real connector. See docs/fanout.md.
export const notion = stubConnector("notion", "Notion", ["NOTION_TOKEN"]);
