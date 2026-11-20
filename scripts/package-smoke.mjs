import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [runtime, installDir] = process.argv.slice(2);
assert(runtime === "node" || runtime === "bun", "expected node or bun");
assert(installDir, "expected a temporary package installation directory");
const bin = join(installDir, "node_modules", ".bin", "deepseek-web-tools");
const transport = new StdioClientTransport({
  command: runtime === "bun" ? "bun" : bin,
  args: runtime === "bun" ? [bin] : [],
  cwd: installDir,
  env: {
    // Discovery is local and must never use a real key or remote endpoint.
    DEEPSEEK_API_KEY: "smoke-test-placeholder",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
  },
});
const client = new Client({ name: "package-smoke-test", version: "1.0.0" });
const watchdog = setTimeout(() => {
  console.error("Timed out initializing the installed MCP server or listing its tools");
  process.exit(1);
}, 10_000);

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "deepseek-web-tools");
  const { tools, nextCursor } = await client.listTools();
  assert.equal(nextCursor, undefined, "expected a single page of tools");
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["fetch", "search"]);
  assert(tools.every(({ annotations }) => annotations?.readOnlyHint === true));
  console.log(`Installed package initialized on ${runtime} and listed fetch and search`);
} finally {
  try {
    await client.close();
  } finally {
    clearTimeout(watchdog);
  }
}
