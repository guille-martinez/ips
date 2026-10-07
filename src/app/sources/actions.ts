"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { SOURCES, type Source } from "@/db/schema";
import { runAll, runSource } from "@/sync/run";

export async function syncNow(formData: FormData) {
  const source = String(formData.get("source") ?? "");
  if (source === "all") await runAll(getDb());
  else if ((SOURCES as readonly string[]).includes(source)) await runSource(getDb(), source as Source);
  revalidatePath("/", "layout");
  revalidatePath("/sources");
  revalidatePath("/feed");
}
