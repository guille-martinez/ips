import "@/lib/load-env";
import { getDb } from "@/db/client";

getDb();
console.log("migrations applied");
