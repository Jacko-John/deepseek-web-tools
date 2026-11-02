/**
 * Load and validate runtime configuration from environment variables.
 *
 * The server fails fast at startup when the API key is missing or the base URL
 * would send the key somewhere unsafe. Everything else has a documented
 * default so a minimal MCP client configuration only needs the key.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

export interface ApiConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  totalTimeoutMs: number;
  maxAttempts: number;
}

export interface ToolConfig {
  searchCount: number;
  searchMaxChars: number;
  fetchMaxChars: number;
  outputDir: string;
}

export interface Config extends ApiConfig, ToolConfig {}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  timeoutMs: 25_000,
  totalTimeoutMs: 55_000,
  maxAttempts: 2,
  searchCount: 10,
  searchMaxChars: 50_000,
  fetchMaxChars: 50_000,
  outputDir: join(tmpdir(), "deepseek-web-tools"),
} as const;

/** Read an optional integer, rejecting values outside the documented range. */
function readInteger(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Resolve the API key from a literal environment variable or a key file. */
function readApiKey(env: Env): string {
  const literal = env.DEEPSEEK_API_KEY?.trim();
  if (literal) return literal;

  const configuredPath = env.DEEPSEEK_API_KEY_FILE?.trim();
  if (!configuredPath) {
    throw new Error("Set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE.");
  }

  const path = resolve(configuredPath);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read DEEPSEEK_API_KEY_FILE at ${path}: ${message}`);
  }
  if (!contents) throw new Error(`DEEPSEEK_API_KEY_FILE at ${path} is empty.`);
  return contents;
}

/** HTTP is allowed only for a local proxy; remote base URLs must use HTTPS. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * Normalize the API base URL.
 *
 * Accepts an optional path prefix for gateways and strips a trailing `/v1` so
 * both `https://api.deepseek.com` and the common `.../v1` copy-paste work.
 */
function readBaseUrl(env: Env): string {
  const raw = env.DEEPSEEK_BASE_URL?.trim() || DEFAULTS.baseUrl;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DEEPSEEK_BASE_URL must be a valid URL.");
  }

  if (url.username || url.password) {
    throw new Error("DEEPSEEK_BASE_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("DEEPSEEK_BASE_URL must not contain a query or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("DEEPSEEK_BASE_URL must use HTTPS (HTTP is allowed only for loopback).");
  }

  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

/** Resolve the directory used for oversized search output. */
function readOutputDir(env: Env): string {
  const raw = env.DEEPSEEK_OUTPUT_DIR?.trim();
  return raw ? resolve(raw) : join(tmpdir(), "deepseek-web-tools");
}

/** Load configuration once at startup. */
export function loadConfig(env: Env = process.env): Config {
  return {
    apiKey: readApiKey(env),
    baseUrl: readBaseUrl(env),
    timeoutMs: readInteger(env, "DEEPSEEK_TIMEOUT_MS", DEFAULTS.timeoutMs, 1_000, 60_000),
    totalTimeoutMs: readInteger(
      env,
      "DEEPSEEK_TOTAL_TIMEOUT_MS",
      DEFAULTS.totalTimeoutMs,
      1_000,
      300_000,
    ),
    maxAttempts: readInteger(env, "DEEPSEEK_MAX_ATTEMPTS", DEFAULTS.maxAttempts, 1, 5),
    searchCount: readInteger(env, "DEEPSEEK_SEARCH_COUNT", DEFAULTS.searchCount, 1, 50),
    searchMaxChars: readInteger(
      env,
      "DEEPSEEK_SEARCH_MAX_CHARS",
      DEFAULTS.searchMaxChars,
      1_000,
      500_000,
    ),
    fetchMaxChars: readInteger(
      env,
      "DEEPSEEK_FETCH_MAX_CHARS",
      DEFAULTS.fetchMaxChars,
      1_000,
      1_000_000,
    ),
    outputDir: readOutputDir(env),
  };
}
