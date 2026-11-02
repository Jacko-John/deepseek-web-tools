import { describe, expect, test } from "bun:test";
import { DeepSeekApiError, DeepSeekClient } from "../src/deepseek";
import type { ApiConfig } from "../src/config";

const API_KEY = "sk-test-secret-123456";

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    apiKey: API_KEY,
    baseUrl: "https://api.deepseek.com",
    timeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    maxAttempts: 2,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const RAW_RESULT = {
  rerank_score: 2.4,
  title: "Example",
  url: "https://example.com/page",
  snippet: "short",
  summary: "long summary",
  content: "",
  site_name: "Example",
  site_icon: "https://example.com/favicon.ico",
  date: "2026-01-02T03:04:05Z",
  authority: 3,
};

describe("DeepSeekClient.search", () => {
  test("passes every official request field through and preserves the response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ results: [RAW_RESULT] });
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    const result = await client.search({
      query: "example",
      count: 2,
      ori_question: null,
      localization: "203.0.113.7",
      need_content: true,
    });

    expect(result).toEqual({ results: [RAW_RESULT] });
    expect(calls[0]?.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: "example",
      count: 2,
      ori_question: null,
      localization: "203.0.113.7",
      need_content: true,
    });
  });

  test("omits unset optional fields so the API applies its own defaults", async () => {
    let body: unknown;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    const result = await client.search({ query: "only-query" });

    expect(result).toEqual({ results: [] });
    expect(body).toEqual({ query: "only-query" });
  });

  test("retries a transient HTTP failure once", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: { message: "temporary" } }, 500, {
          "retry-after": "0",
        });
      }
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    await expect(client.search({ query: "retry" })).resolves.toEqual({ results: [] });
    expect(attempts).toBe(2);
  });

  test("does not retry a client error and exposes the official error fields", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return jsonResponse(
        {
          error: {
            message: `invalid key ${API_KEY}`,
            type: "invalid_request_error",
            param: null,
            code: "invalid_request_error",
          },
        },
        401,
      );
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig({ maxAttempts: 3 }), fetchImpl);
    let error: unknown;
    try {
      await client.search({ query: "bad" });
    } catch (caught) {
      error = caught;
    }

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(DeepSeekApiError);
    const apiError = error as DeepSeekApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.type).toBe("invalid_request_error");
    expect(apiError.param).toBeNull();
    expect(apiError.code).toBe("invalid_request_error");
    expect(apiError.message).not.toContain(API_KEY);
    expect(apiError.message).toContain("[redacted]");
  });

  test("retries a network failure once", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    await expect(client.search({ query: "network" })).resolves.toEqual({ results: [] });
    expect(attempts).toBe(2);
  });
});

describe("DeepSeekClient.fetchPage", () => {
  test("returns the full official response without truncating", async () => {
    const content = "abcdefgh".repeat(20);
    const fetchImpl = (async () =>
      jsonResponse({ title: "Title", content })) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    const result = await client.fetchPage({ url: "https://example.com" });

    expect(result).toEqual({ title: "Title", content });
  });

  test("preserves an empty content string for the presentation layer", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ title: "Title", content: "" })) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    await expect(client.fetchPage({ url: "https://example.com" })).resolves.toEqual({
      title: "Title",
      content: "",
    });
  });

  test("rejects a response missing title or content", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ title: "Title" })) as unknown as typeof fetch;

    const client = new DeepSeekClient(makeConfig(), fetchImpl);
    await expect(client.fetchPage({ url: "https://example.com" })).rejects.toThrow(
      "missing title or content",
    );
  });
});
