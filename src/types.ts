/**
 * Domain types for @browsercore/crawlee.
 *
 * The option surface mirrors @crawlee/impit-client's constructor shape —
 * `browser`-style profile pinning, a wall-clock timeout for signal-less use,
 * and a redirect limit for callers that delegate redirect following to the
 * underlying stack — adapted to browsersmith's vocabulary.
 */

import type { CrawleeLogger } from "@crawlee/types";
import type { ProfileId } from "@browsercore/profiles";
import type { Platform } from "browsersmith";
import type { Transport } from "@browsercore/transport";

/**
 * Profile selection for {@link BrowsersmithHttpClientOptions.profile}.
 *
 * - A concrete profile id (e.g. `"chrome-140"`, `"firefox-128"`) pins every
 *   request to that TLS + HTTP/2 fingerprint, overriding any per-session
 *   browser hint — mirroring how ImpitHttpClient's `browser` option overrides
 *   session fingerprints.
 * - `"auto"` (the default) derives the profile per request from the session
 *   fingerprint's browser family (`fingerprint.browser`), falling back to
 *   `chrome-140` when the session carries no fingerprint. Chromium-based
 *   families the stack does not model (`edge`, `safari`) map onto the Chrome
 *   profile like impit maps them onto Chrome.
 */
export type ProfileSelection = ProfileId | "auto";

/** Options for {@link BrowsersmithHttpClient}. */
export interface BrowsersmithHttpClientOptions {
    /**
     * Browser profile to impersonate — either a concrete profile id from the
     * browsersmith registry (`"chrome-140"`, `"firefox-128"`, …) or `"auto"`
     * to derive it per request from the session fingerprint. Default `"auto"`
     * (fingerprint-driven, chrome-140 fallback).
     *
     * An unknown profile id throws `UnknownProfileError` at construction.
     */
    readonly profile?: ProfileSelection;
    /**
     * Request timeout in milliseconds, used only when a request carries no
     * `AbortSignal` (crawlee always supplies one derived from the navigation
     * window; the signal then owns the deadline, mirroring impit's
     * `timeout: null` signal-mode). Default: browsersmith's 30 000 ms.
     */
    readonly timeoutMs?: number;
    /**
     * Redirect limit handed to browsersmith. Crawlee's `BaseHttpClient`
     * performs redirect handling itself (manual mode, capped at 10 hops), so
     * the limit only takes effect when redirect following is delegated to
     * browsersmith — i.e. when a caller invokes `fetch` directly with
     * `redirect: "follow"`. Default 20.
     */
    readonly maxRedirects?: number;
    /**
     * Fail fast at construction. browsersmith cannot disable TLS certificate
     * validation (see {@link IgnoreTlsErrorsUnsupportedError}); the flag is
     * rejected here too so a client configured for MITM proxies fails before
     * its first crawl instead of on every request.
     */
    readonly ignoreTlsErrors?: boolean;
    /**
     * Crawlee logger, passed to `BaseHttpClient` for cookie-application
     * warnings and available to subclasses.
     */
    readonly logger?: CrawleeLogger;
    /**
     * Advanced: platform composition root for the underlying browsersmith
     * client. Defaults to browsersmith's Node.js singleton. Non-Node runtimes
     * (Bun, Deno) supply their own adapters here.
     */
    readonly platform?: Platform;
    /**
     * Advanced test seam forwarded to browsersmith's `createClient`:
     * when set, transports for an origin are obtained from this factory
     * instead of a real TCP + TLS dial, and the HTTP/1.1 layer speaks to the
     * returned `Transport` directly. This is also the only path that can
     * reach plain-`http://` origins — browsersmith's real dial always
     * negotiates TLS, so `http://` targets require an injected transport.
     *
     * Note the proxy interaction: when a request is proxied, the factory is
     * dialed with the PROXY's host/port (it stands in for the tunnel), not
     * the origin's.
     */
    readonly transportFactory?: (host: string, port: number) => Promise<Transport> | Transport;
}
