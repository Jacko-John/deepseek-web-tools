import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistOutput } from "../src/output";

describe("persistOutput", () => {
  test("writes the full text to a private file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-tools-output-"));
    try {
      const fullText = 'Web search results for query: "test"\n\n1. Example';
      const path = await persistOutput("search", fullText, dir);

      expect(path.startsWith(dir)).toBe(true);
      expect(path).toContain("search-");
      expect(readFileSync(path, "utf8")).toBe(fullText);
      expect(statSync(path).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
