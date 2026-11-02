#!/usr/bin/env node
/**
 * stdio entry point for deepseek-web-tools.
 *
 * stdout is reserved for the MCP protocol. Startup failures go to stderr and
 * produce a non-zero exit so a client can surface the configuration problem.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { DeepSeekClient } from "./deepseek.js";
import { createServer } from "./server.js";

try {
  const config = loadConfig();
  const client = new DeepSeekClient(config);
  await createServer(client, config).connect(new StdioServerTransport());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`deepseek-web-tools: ${message}\n`);
  process.exitCode = 1;
}
