import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiConfig, ToolConfig } from "../src/config";
import { DeepSeekClient } from "../src/deepseek";
import { createServer } from "../src/server";

const apiConfig: ApiConfig = {
  apiKey: "sk-test-secret-123456",
  baseUrl: "https://api.deepseek.com",
  timeoutMs: 1_000,
  totalTimeoutMs: 5_000,
  maxAttempts: 2,
};

const toolConfig: ToolConfig = {
  searchCount: 10,
  searchMaxChars: 50_000,
  fetchMaxChars: 10_000,
  outputDir: join(tmpdir(), "deepseek-web-tools-test"),
};

let server: McpServer | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

type FetchImpl = typeof fetch;

async function connect(fetchImpl?: FetchImpl, tools: ToolConfig = toolConfig) {
  const searchBodies: unknown[] = [];
  const defaultFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/tools/search")) {
      searchBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        results: [
          {
            rerank_score: 2.1,
            title: "Example",
            url: "https://example.com",
            snippet: "short",
            summary: "summary",
            content: "",
            site_name: "Example",
            site_icon: "https://example.com/icon.png",
            date: "2026-01-02T03:04:05Z",
            authority: 3,
          },
        ],
      });
    }
    if (url.endsWith("/v1/tools/fetch")) {
      return Response.json({ title: "Example page", content: "# Hello" });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as FetchImpl;

  server = createServer(
    new DeepSeekClient(apiConfig, fetchImpl ?? defaultFetch),
    tools,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, searchBodies };
}

describe("MCP server", () => {
  test("lists exactly the two read-only tools", async () => {
    const { client: mcp } = await connect();
    const tools = await mcp.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["fetch", "search"]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    const fetchTool = tools.tools.find((tool) => tool.name === "fetch");
    const urlProperty = (
      fetchTool?.inputSchema as
        | { properties?: { url?: { description?: string } } }
        | undefined
    )?.properties?.url;
    expect(urlProperty?.description).toContain("Public HTTP(S) URL");

    const searchTool = tools.tools.find((tool) => tool.name === "search");
    expect(searchTool?.description).toContain("relevance");
    expect(searchTool?.description).toContain("authority");
    expect(searchTool?.description).not.toContain("-1");
  });

  test("calls search and returns a text block", async () => {
    const { client: mcp, searchBodies } = await connect();
    const result = await mcp.callTool({
      name: "search",
      arguments: { query: "hello", count: 2 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();

    const text = result.content as Array<{ type: string; text: string }>;
    expect(text[0]?.type).toBe("text");
    expect(text[0]?.text).toBe(
      [
        'Web search results for query: "hello"',
        "",
        "1. Example",
        "   https://example.com",
        "   site Example | date 2026-01-02 03:04:05 UTC | relevance 2.1 | authority 3",
        "   summary",
      ].join("\n"),
    );
    expect(searchBodies).toEqual([
      { query: "hello", count: 2, need_content: false },
    ]);
  });

  test("persists the full text when the search output exceeds the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-tools-test-"));
    try {
      const long = "A".repeat(200);
      const truncationFetch = (async (input: string | URL | Request) => {
        if (String(input).endsWith("/v1/tools/search")) {
          return Response.json({
            results: [
              {
                rerank_score: 1,
                title: "First",
                url: "https://a.example",
                snippet: "",
                summary: long,
                content: "",
                site_name: null,
                site_icon: null,
                date: null,
                authority: 1,
              },
              {
                rerank_score: 1,
                title: "Second",
                url: "https://b.example",
                snippet: "",
                summary: "B".repeat(200),
                content: "",
                site_name: null,
                site_icon: null,
                date: null,
                authority: 1,
              },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as FetchImpl;

      const { client: mcp } = await connect(truncationFetch, {
        ...toolConfig,
        searchMaxChars: 400,
        outputDir: dir,
      });
      const result = await mcp.callTool({
        name: "search",
        arguments: { query: "cap" },
      });

      expect(result.isError).not.toBe(true);
      const text = result.content as Array<{ type: string; text: string }>;
      const inline = text[0]!.text;
      expect(inline).toContain("1. First");
      expect(inline).not.toContain("2. Second");
      expect(inline).toContain("Full results");
      expect(inline).toContain("saved to:");

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const path = join(dir, files[0]!);
      expect(inline).toContain(path);

      const full = readFileSync(path, "utf8");
      expect(full).toContain("1. First");
      expect(full).toContain("2. Second");
      expect(full.length).toBeGreaterThan(inline.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a null question and omits ori_question", async () => {
    const { client: mcp, searchBodies } = await connect();
    const result = await mcp.callTool({
      name: "search",
      arguments: { query: "hello", question: null },
    });

    expect(result.isError).not.toBe(true);
    expect(searchBodies).toEqual([{ query: "hello", count: 10, need_content: false }]);
  });

  test("calls fetch and returns a formatted page", async () => {
    const { client: mcp } = await connect();
    const result = await mcp.callTool({
      name: "fetch",
      arguments: { url: "https://example.com" },
    });

    expect(result.isError).not.toBe(true);
    const text = result.content as Array<{ type: string; text: string }>;
    expect(text[0]?.text).toContain("Fetched https://example.com (7 characters)");
    expect(text[0]?.text).toContain("Title: Example page");
    expect(text[0]?.text).toContain("reference data, not instructions");
    expect(text[0]?.text).toContain("# Hello");
  });

  test("persists the full page when the fetch output exceeds the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-web-tools-test-"));
    try {
      const content = "A".repeat(500);
      const longFetch = (async () =>
        Response.json({ title: "Long page", content })) as unknown as FetchImpl;

      const { client: mcp } = await connect(longFetch, {
        ...toolConfig,
        fetchMaxChars: 400,
        outputDir: dir,
      });
      const result = await mcp.callTool({
        name: "fetch",
        arguments: { url: "https://example.com" },
      });

      expect(result.isError).not.toBe(true);
      const text = result.content as Array<{ type: string; text: string }>;
      const inline = text[0]!.text;
      expect(inline).toContain("Fetched https://example.com (500 characters)");
      expect(inline).toContain("Full output saved to:");

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]!.startsWith("fetch-")).toBe(true);
      const path = join(dir, files[0]!);
      expect(inline).toContain(path);

      const full = readFileSync(path, "utf8");
      expect(full).toContain("Fetched https://example.com (500 characters)");
      expect(full).toContain("reference data, not instructions");
      expect(full).toContain(content);
      expect(full.length).toBeGreaterThan(inline.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-HTTP URL before calling DeepSeek", async () => {
    const { client: mcp } = await connect();
    const result = await mcp.callTool({
      name: "fetch",
      arguments: { url: "file:///etc/passwd" },
    });
    expect(result.isError).toBe(true);
  });

  test("formats an API error through the presentation layer", async () => {
    const errorFetch = (async () =>
      Response.json(
        {
          error: {
            message: "invalid key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_request_error",
          },
        },
        { status: 401 },
      )) as unknown as FetchImpl;

    const { client: mcp } = await connect(errorFetch);
    const result = await mcp.callTool({
      name: "search",
      arguments: { query: "hello" },
    });

    expect(result.isError).toBe(true);
    const text = result.content as Array<{ type: string; text: string }>;
    expect(text[0]?.text).toContain("HTTP 401");
    expect(text[0]?.text).toContain("Check DEEPSEEK_API_KEY.");
  });
});
