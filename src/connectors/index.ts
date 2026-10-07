import type { Source } from "@/db/schema";
import type { Connector } from "./types";
import { slack } from "./slack";
import { gmail } from "./gmail";
import { calendar } from "./calendar";
import { granola } from "./granola";
import { linear } from "./linear";
import { notion } from "./notion";
import { attio } from "./attio";
import { metabase } from "./metabase";
import { sheets } from "./sheets";

export const connectors: Record<Source, Connector> = {
  slack,
  gmail,
  calendar,
  granola,
  linear,
  notion,
  attio,
  metabase,
  sheets,
};
