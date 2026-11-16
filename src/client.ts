/**
 * BrowsersmithHttpClient — a Crawlee HTTP client backed by browsersmith.
 *
 * Extends `@crawlee/http-client`'s `BaseHttpClient`, whose concrete
 * `sendRequest` owns redirect handling (manual-mode loop, 10-hop cap,
 * 301/302-POST→GET and 303 semantics, cross-origin credential stripping) and
 * cookie interchange (session jar → `cookie` header per hop; response
 * `Set-Cookie` → jar via `headers.getSetCookie()`). This class implements the
 * one abstract primitive, `fetch`: a single raw network request through
 * browsersmith's browser-identical TLS + HTTP/2 fingerprint stack, mapped
 * from the `CustomFetchOptions` the base hands in.
 *
 * Mapping (per option, with impit as the reference implementation):
 * - `proxyUrl` → `parseProxyUrl` (`http`/`socks5`/`socks5h`; an `https` proxy
 *   scheme is a typed `ProxyConfigError` naming the scheme — the same
 *   limitation @browsercore/proxy documents).
 * - `fingerprint.browser` → profile: `firefox` → `firefox-128`,
 *   `chrome`/`edge`/`safari` → `chrome-140` (impit collapses Chromium-based
 *   families onto Chrome too); a client-level explicit `profile` wins, and
 *   fingerprint-less requests default to `chrome-140`.
 * - `cookieJar` → not forwarded (Crawlee's async jar and browsersmith's sync
 *   jar are incompatible objects); cookies interchange as HTTP headers —
 *   request cookies arrive on the header from Crawlee's session, and the
 *   wrapped Response re-exposes every wire `Set-Cookie` via
 *   `fetchResponse.getSetCookie()` for the base to harvest.
 * - `ignoreTlsErrors` → typed {@link IgnoreTlsErrorsUnsupportedError}:
 *   browsersmith performs real certificate-validating handshakes and cannot
 *   skip validation.
 * - `signal` → forwarded; while present it owns the deadline, so
 *   browsersmith's wall-clock timer is set past any practical crawl length
 *   (mirroring impit's `timeout: null` signal mode).
 *
 * One `FetchClient` per client instance (connection pooling lives in
 * browsersmith); no additional queuing — Crawlee owns concurrency.
 */

import { BaseHttpClient, type CustomFetchOptions } from "@crawlee/http-client";
import type { Cookie, CookieJar, CookieUrl, SameSiteContext } from "@browsercore/cookies";
import {
    createClient,
    getProfile,
    parseProxyUrl,
    platform,
    type FetchClient,
    type FetchMethod,
    type FetchOptions,
    type ProfileId,
} from "browsersmith";
import { IgnoreTlsErrorsUnsupportedError, UnsupportedHttpMethodError } from "./errors.js";
import { resolveProfileId } from "./profile.js";
import { toCrawleeResponse } from "./response.js";
import type { BrowsersmithHttpClientOptions } from "./types.js";

/** HTTP methods browsersmith's `FetchMethod` union models. */
const SUPPORTED_HTTP_METHODS: ReadonlySet<string> = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
]);

/**
 * Wall-clock deadline applied while a caller `AbortSignal` owns the real
 * deadline. browsersmith's dispatch timer cannot be disabled (it falls back
 * to 30 000 ms when no timeout is configured), so signal-mode requests get
 * the `setTimeout` ceiling (~24.8 days) — the equivalent of impit's
 * `timeout: null`, never firing before the signal does.
 */
const SIGNAL_OWNED_DEADLINE_MS = 2_147_483_647;

/**
 * A browsersmith jar that deliberately stores nothing — the client-level
 * `cookieJar` handed to `createClient` so browsersmith's own cookie engine
 * stays out of the way. Crawlee's `BaseHttpClient` owns cookies: request
 * cookies arrive on the `cookie` header (the base applies the session jar),
 * and response cookies flow back through the wrapped Response's
 * `getSetCookie()`. Without this, browsersmith's default jar would store
 * response cookies and its `applyCookies` would then OVERWRITE the header on
 * subsequent requests — hijacking the session's cookies. Inert on both
 * sides; cookie fidelity is header-based end to end.
 */
export class InertCookieJar implements CookieJar {
    public readonly id = "browsercore-crawlee-inert" as never;

    public getCookies(_url: CookieUrl, _context?: SameSiteContext): Cookie[] {
        return [];
    }

    public setCookie(_raw: string, _url: CookieUrl): void {
        // Cookies are interchange-format only — the session jar is Crawlee's.
    }

    public removeCookie(_name: string, _domain: string, _path: string): void {
        // Nothing stored, nothing to remove.
    }

    public clear(): void {
        // Nothing stored, nothing to clear.
    }

    public serialize(): string {
        return "{}";
    }

    public deserialize(_json: string): void {
        // Deliberately stateless — nothing to restore.
    }
}

/**
 * Crawlee HTTP client that fetches through browsersmith — browser-identical
 * TLS/HTTP2 fingerprints, HTTP CONNECT and SOCKS5/5h proxying, zero native
 * dependencies.
 *
 * @example
 * ```ts
 * import { CheerioCrawler } from "crawlee";
 * import { BrowsersmithHttpClient } from "@browsercore/crawlee";
 *
 * const crawler = new CheerioCrawler({
 *     httpClient: new BrowsersmithHttpClient(),
 *     async requestHandler({ $ }) {
 *         console.log($("title").text());
 *     },
 * });
 * ```
 *
 * @since 0.1.0
 */
export class BrowsersmithHttpClient extends BaseHttpClient {
    /** One pooled browsersmith client per BrowsersmithHttpClient instance. */
    readonly #client: FetchClient;
    readonly #profileSelection: "auto" | ProfileId;
    readonly #timeoutMs: number | undefined;
    readonly #maxRedirects: number;

    /**
     * @param options - Profile pinning, timeouts, logger, and advanced
     *   platform/transport seams. See {@link BrowsersmithHttpClientOptions}.
     * @throws {IgnoreTlsErrorsUnsupportedError} `options.ignoreTlsErrors` is set.
     * @throws {UnknownProfileError} `options.profile` names an unregistered profile.
     */
    constructor(options: BrowsersmithHttpClientOptions = {}) {
        super(options.logger === undefined ? {} : { logger: options.logger });
        if (options.ignoreTlsErrors === true) {
            throw new IgnoreTlsErrorsUnsupportedError({ source: "constructor" });
        }
        // Fail fast on an unknown profile id (the registry's own typed error)
        // instead of surfacing it from the depths of the first request.
        if (options.profile !== undefined && options.profile !== "auto") {
            getProfile(options.profile);
        }
        this.#client = createClient(assembleClientOptions(options));
        this.#profileSelection = options.profile ?? "auto";
        this.#timeoutMs = options.timeoutMs;
        this.#maxRedirects = options.maxRedirects ?? 20;
    }

    /**
     * Release browsersmith's pooled connections. Call when done with the
     * client (Crawlee does not know about this lifecycle — it is on the
     * embedding application).
     */
    public async close(): Promise<void> {
        await this.#client.close();
    }

    /**
     * Perform the raw single-hop network request through browsersmith.
     *
     * @param request - The request with Crawlee's jar cookies already applied
     *   to the `cookie` header; forwarded verbatim.
     * @param init - Signal plus the `CustomFetchOptions` populated by
     *   `sendRequest` (proxyUrl, fingerprint, ignoreTlsErrors).
     */
    protected override async fetch(
        request: Request,
        init?: RequestInit & CustomFetchOptions,
    ): Promise<Response> {
        if (init?.ignoreTlsErrors === true) {
            throw new IgnoreTlsErrorsUnsupportedError({ source: "request" });
        }
        const method = assertSupportedMethod(request.method);
        const proxy = init?.proxyUrl === undefined ? undefined : parseProxyUrl(init.proxyUrl);
        const profile = resolveProfileId(this.#profileSelection, init?.fingerprint);
        const body = await drainRequestBody(request);
        const fetchOptions = assembleFetchOptions({
            request,
            init,
            method,
            profile,
            proxy,
            body,
            timeoutMs: hasSignal(init?.signal) ? SIGNAL_OWNED_DEADLINE_MS : this.#timeoutMs,
            maxRedirects: this.#maxRedirects,
        });
        const fetchResponse = await this.#client.fetch(request.url, fetchOptions);
        return toCrawleeResponse(fetchResponse);
    }
}

/** Only-assign-present-keys assembly — exactOptionalPropertyTypes forbids explicit `undefined` values. */
function assembleClientOptions(options: BrowsersmithHttpClientOptions): Parameters<typeof createClient>[0] {
    return {
        // Crawlee owns cookies (see InertCookieJar) — browsersmith's own jar
        // must stay out of the request/response cookie path.
        cookieJar: new InertCookieJar(),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        // fetch has no fallback EventProvider — default to browsersmith's Node
        // platform singleton unless the caller injects their own composition root.
        platform: options.platform ?? platform,
        ...(options.transportFactory === undefined ? {} : { transportFactory: options.transportFactory }),
    };
}

type FetchOptionsAssembly = {
    readonly request: Request;
    readonly init: RequestInit & CustomFetchOptions | undefined;
    readonly method: FetchMethod;
    readonly profile: ProfileId;
    readonly proxy: ReturnType<typeof parseProxyUrl> | undefined;
    readonly body: Uint8Array | undefined;
    readonly timeoutMs: number | undefined;
    readonly maxRedirects: number;
};

/** Only-assign-present-keys assembly of the per-request browsersmith options. */
function assembleFetchOptions(assembly: FetchOptionsAssembly): FetchOptions {
    // WHATWG types the request signal `AbortSignal | null` (null = absent);
    // browsersmith's option is `?: AbortSignal`, so null collapses to absence.
    const presentSignal = assembly.init?.signal ?? undefined;
    return {
        method: assembly.method,
        headers: headersToRecord(assembly.request.headers),
        profile: assembly.profile,
        followRedirects: assembly.init?.redirect === "follow",
        maxRedirects: assembly.maxRedirects,
        ...(assembly.body === undefined ? {} : { body: assembly.body }),
        ...(assembly.proxy === undefined ? {} : { proxy: assembly.proxy }),
        ...(assembly.timeoutMs === undefined ? {} : { timeoutMs: assembly.timeoutMs }),
        ...(presentSignal === undefined ? {} : { signal: presentSignal }),
    };
}

/** Collapse a WHATWG `Headers` into browsersmith's flat record. */
function headersToRecord(headers: Headers): Record<string, string> {
    return Object.fromEntries(headers.entries());
}

/** Whether the request init carries a live abort signal (WHATWG types it `AbortSignal | null`). */
function hasSignal(signal: AbortSignal | null | undefined): boolean {
    return signal !== undefined && signal !== null;
}

/**
 * Drain the WHATWG request body into the bytes browsersmith's `FetchOptions`
 * accepts. Absent bodies stay absent (GET/HEAD carry none).
 */
async function drainRequestBody(request: Request): Promise<Uint8Array | undefined> {
    if (request.body === null) {
        return undefined;
    }
    return new Uint8Array(await request.arrayBuffer());
}

/** Reject methods outside browsersmith's modeled set with a typed error. */
function assertSupportedMethod(method: string): FetchMethod {
    const upper = method.toUpperCase();
    if (!SUPPORTED_HTTP_METHODS.has(upper)) {
        throw new UnsupportedHttpMethodError(upper);
    }
    return upper as FetchMethod;
}
