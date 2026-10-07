import { expect, it } from "vitest";
import { redact } from "@/lib/redact";

it("redacts tokens from error messages", () => {
  process.env.TEST_API_KEY = "supersecretvalue123";
  const out = redact("failed with supersecretvalue123 and xoxp-1-2-3 and Bearer abc.def");
  expect(out).not.toContain("supersecretvalue123");
  expect(out).not.toContain("xoxp-1-2-3");
  expect(out).not.toContain("abc.def");
});
