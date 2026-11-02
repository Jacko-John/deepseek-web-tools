/**
 * DeepSeek Search/Fetch API client.
 *
 * This layer mirrors the official HTTP API one-to-one: official request fields,
 * official snake_case response fields, nullable values preserved, and full page
 * content returned without truncation. Agent-facing shaping lives in
 * `presentation.ts`; tool registration lives in `server.ts`.
 */
import type { ApiConfig } from "./config.js";

/** Request body for `POST /v1/tools/search`. All fields match the official schema. */
export interface SearchRequest {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string;
  need_content?: boolean;
}

/** One item in the official `results` array. */
export interface SearchResult {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
}

/** Official response body for `POST /v1/tools/search`. */
export interface SearchResponse {
  results: SearchResult[];
}

/** Request body for `POST /v1/tools/fetch`. */
export interface FetchRequest {
  url: string;
}

/** Official response body for `POST /v1/tools/fetch`. */
export interface FetchResponse {
  title: string;
  content: string;
}

/** Structured HTTP error returned by DeepSeek. */
export class DeepSeekApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    readonly param: string | null | undefined,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

type FetchImpl = typeof fetch;
type RawRecord = Record<string, unknown>;

const RETRYABLE_STATUS = new Set([408, 429]);

/** Treat only non-null, non-array objects as API records. */
function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wait for a bounded delay, rejecting early when the caller aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Request cancelled."));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Request cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parse `Retry-After` as delay seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/** Keep the API key out of messages that reach the model. */
function redact(text: string, secret: string): string {
  return secret.length >= 8 ? text.replaceAll(secret, "[redacted]") : text;
}

/** Extract the official OpenAI-compatible error fields without leaking the key. */
function parseApiError(
  body: unknown,
  secret: string,
): {
  message: string;
  type: string | undefined;
  param: string | null | undefined;
  code: string | undefined;
} {
  const root = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return {
    message:
      typeof root?.message === "string" ? redact(root.message, secret) : "Request failed.",
    type: typeof root?.type === "string" ? root.type : undefined,
    param:
      typeof root?.param === "string" || root?.param === null ? root.param : undefined,
    code: typeof root?.code === "string" ? root.code : undefined,
  };
}

/** Build the exact official Search request body, omitting only unset fields. */
function buildSearchPayload(request: SearchRequest): RawRecord {
  const payload: RawRecord = { query: request.query };
  if (request.count !== undefined) payload.count = request.count;
  if (request.ori_question !== undefined) payload.ori_question = request.ori_question;
  if (request.localization !== undefined) payload.localization = request.localization;
  if (request.need_content !== undefined) payload.need_content = request.need_content;
  return payload;
}

export class DeepSeekClient {
  constructor(
    private readonly config: ApiConfig,
    private readonly fetchImpl: FetchImpl = globalThis.fetch,
  ) {}

  /** Call `POST /v1/tools/search` and return the official response unchanged. */
  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const body = await this.request("search", buildSearchPayload(request), signal);
    if (!Array.isArray(body.results)) {
      throw new Error("DeepSeek search response is missing the results array.");
    }
    if (!body.results.every((item) => isRecord(item))) {
      throw new Error("DeepSeek search response contains a non-object result.");
    }
    return { results: body.results as unknown as SearchResult[] };
  }

  /** Call `POST /v1/tools/fetch` and return the official response unchanged. */
  async fetchPage(request: FetchRequest, signal?: AbortSignal): Promise<FetchResponse> {
    const body = await this.request("fetch", { url: request.url }, signal);
    if (typeof body.title !== "string" || typeof body.content !== "string") {
      throw new Error("DeepSeek fetch response is missing title or content.");
    }
    return { title: body.title, content: body.content };
  }

  /** POST to a DeepSeek tool endpoint, retrying transient failures within one deadline. */
  private async request(
    endpoint: "search" | "fetch",
    payload: RawRecord,
    callerSignal?: AbortSignal,
  ): Promise<RawRecord> {
    if (callerSignal?.aborted) throw new Error("Request cancelled.");

    const url = `${this.config.baseUrl}/v1/tools/${endpoint}`;
    const deadline = Date.now() + this.config.totalTimeoutMs;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`DeepSeek ${endpoint} timed out.`);

        const timeoutMs = Math.min(this.config.timeoutMs, remaining);
        const attemptController = new AbortController();
        const onParentAbort = () => attemptController.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", onParentAbort, { once: true });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, timeoutMs);

        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            redirect: "error",
            signal: attemptController.signal,
          });
        } catch (error) {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", onParentAbort);

          if (callerSignal?.aborted) throw new Error("Request cancelled.");
          if (timedOut) {
            if (attempt < this.config.maxAttempts && deadline > Date.now()) continue;
            throw new Error(`DeepSeek ${endpoint} timed out after ${timeoutMs} ms.`);
          }

          if (attempt < this.config.maxAttempts && deadline > Date.now()) {
            const wait = Math.min(500 * attempt, Math.max(0, deadline - Date.now()));
            await sleep(wait, controller.signal);
            continue;
          }

          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `DeepSeek ${endpoint} request failed: ${redact(message, this.config.apiKey)}`,
          );
        }

        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onParentAbort);
        if (callerSignal?.aborted) throw new Error("Request cancelled.");

        const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
        if (retryable && attempt < this.config.maxAttempts) {
          if (response.body) await response.body.cancel().catch(() => undefined);
          const wait = retryAfterMs(response.headers.get("retry-after")) ?? 500 * attempt;
          const bounded = Math.max(0, Math.min(wait, deadline - Date.now()));
          await sleep(bounded, controller.signal);
          continue;
        }

        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const parsed = parseApiError(body, this.config.apiKey);
          throw new DeepSeekApiError(
            response.status,
            parsed.type,
            parsed.param,
            parsed.code,
            parsed.message,
          );
        }
        if (!isRecord(body)) {
          throw new Error(`DeepSeek ${endpoint} returned invalid JSON.`);
        }
        return body;
      }

      throw new Error(`DeepSeek ${endpoint} request could not complete.`);
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.abort();
    }
  }
}
