/**
 * @browsercore/crawlee — public API surface.
 *
 * A Crawlee HTTP client (`BrowsersmithHttpClient`) that routes every crawler
 * request through browsersmith's browser-identical TLS + HTTP/2 fingerprint
 * stack, with HTTP CONNECT / SOCKS5 proxying and zero native dependencies.
 *
 * The package extends `@crawlee/http-client`'s `BaseHttpClient`: Crawlee
 * owns redirect handling and cookie-jar interchange, this package owns the
 * wire — see README for the exact contract and limitations.
 *
 * @module
 */

export { BrowsersmithHttpClient } from "./client.js";
export { SetCookieCaptureJar } from "./cookie-capture.js";
export type { CapturedSetCookies } from "./cookie-capture.js";
export { IgnoreTlsErrorsUnsupportedError, UnsupportedHttpMethodError, BrowsersmithHttpClientError } from "./errors.js";
export { resolveProfileId } from "./profile.js";
export { toCrawleeResponse } from "./response.js";
export type { BrowsersmithHttpClientOptions, ProfileSelection } from "./types.js";

// Re-exports for error matching without importing the underlying stacks —
// the same convenience browsersmith's entrypoint provides over @browsercore/*.
export { FetchError, FetchProxyError, FetchTimeoutError, RedirectError, ProtocolError } from "browsersmith";
export { ProxyConfigError } from "browsersmith";
export { UnknownProfileError } from "@browsercore/profiles";
