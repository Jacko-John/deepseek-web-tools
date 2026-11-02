/** Programmatic entry point. The executable entry lives in `index.ts`. */
export { loadConfig } from "./config.js";
export type { ApiConfig, Config, Env, ToolConfig } from "./config.js";
export { DeepSeekApiError, DeepSeekClient } from "./deepseek.js";
export type {
  FetchRequest,
  FetchResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "./deepseek.js";
export { persistOutput } from "./output.js";
export type { OutputKind } from "./output.js";
export { presentError, presentFetch, presentSearch } from "./presentation.js";
export type { FetchPresentation, SearchPresentation } from "./presentation.js";
export { createServer } from "./server.js";
