import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("uses defaults around a literal API key", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });
    expect(config).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      timeoutMs: 25_000,
      totalTimeoutMs: 55_000,
      maxAttempts: 2,
      searchCount: 10,
      searchMaxChars: 50_000,
      fetchMaxChars: 50_000,
      outputDir: join(tmpdir(), "deepseek-web-tools"),
    });
  });

  test("requires a key", () => {
    expect(() => loadConfig({})).toThrow("Set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE");
  });

  test("reads a key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-tools-"));
    try {
      const path = join(dir, "key");
      writeFileSync(path, "sk-from-file\n", { mode: 0o600 });
      const config = loadConfig({ DEEPSEEK_API_KEY_FILE: path });
      expect(config.apiKey).toBe("sk-from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefers the literal key over the file", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-literal",
      DEEPSEEK_API_KEY_FILE: "/does/not/exist",
    });
    expect(config.apiKey).toBe("sk-literal");
  });

  test("normalizes a copied /v1 base URL", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1/",
    });
    expect(config.baseUrl).toBe("https://api.deepseek.com");
  });

  test("allows HTTP only for loopback", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:8080/proxy",
    });
    expect(config.baseUrl).toBe("http://127.0.0.1:8080/proxy");

    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_BASE_URL: "http://example.com",
      }),
    ).toThrow("must use HTTPS");
  });

  test("rejects credentials and query strings in the base URL", () => {
    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_BASE_URL: "https://user:pass@api.deepseek.com",
      }),
    ).toThrow("must not contain credentials");

    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "sk-test",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com?debug=1",
      }),
    ).toThrow("must not contain a query or fragment");
  });

  test("rejects out-of-range integers", () => {
    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_SEARCH_COUNT: "0" }),
    ).toThrow("DEEPSEEK_SEARCH_COUNT");
  });
});
