# @browsercore/crawlee

[![npm version](https://img.shields.io/npm/v/@browsercore/crawlee)](https://www.npmjs.com/package/@browsercore/crawlee)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-crawlee/badge.json)](https://jverneuer.github.io/browsercore-crawlee/COVERAGE.md)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-crawlee/ci.yml?label=ci)](https://github.com/jverneuer/browsercore-crawlee/actions/workflows/ci.yml)

`@browsercore/crawlee` is a Crawlee HTTP client (`BrowsersmithHttpClient`) that routes every crawler request through browsersmith's browser-identical TLS + HTTP/2 fingerprint stack — the JA3/JA4 ClientHello, HTTP/2 SETTINGS frame order, and header casing a real Chrome (or Firefox) would emit — with HTTP CONNECT and SOCKS5 proxying and **zero native dependencies**. It plugs into any `@crawlee/http-client`-based crawler (`CheerioCrawler`, `HttpCrawler`, `BasicCrawler`, …) via the standard `httpClient` option.

Crawlee keeps everything it is good at (queues, retries, sessions, autoscaling concurrency); this package owns the wire.

## Install

```bash
npm install @browsercore/crawlee
npm install crawlee        # peer: @crawlee/http-client >= 4.0.0-rc.0
```

## Quick usage

```ts
import { CheerioCrawler } from "crawlee";
import { BrowsersmithHttpClient } from "@browsercore/crawlee";

const crawler = new CheerioCrawler({
    httpClient: new BrowsersmithHttpClient(),
    async requestHandler({ $, request }) {
        console.log(request.url, "→", $("title").text());
    },
});

await crawler.run(["https://books.toscrape.com/"]);
```

Every request now completes a real TLS handshake with the `chrome-140` fingerprint — pass Bot Check, whoami.freesample.io-style probes, or your own JA3 collector and the connection looks like Chrome 140 on the wire.

### Proxy rotation

Crawlee's `ProxyConfiguration` works as-is: each session's proxy URL reaches the client and is dialed through browsersmith's own HTTP CONNECT / SOCKS5 tunnel (no `https-proxy-agent`, no native modules).

```ts
import { CheerioCrawler } from "crawlee";
import { BrowsersmithHttpClient } from "@browsercore/crawlee";

const crawler = new CheerioCrawler({
    httpClient: new BrowsersmithHttpClient(),
    proxyUrls: [
        "socks5://user:pass@proxy1.example.com:1080",
        "socks5h://proxy2.example.com:1080", // remote DNS
        "http://user:pass@proxy3.example.com:8080",
    ],
    // Each session keeps its own exit IP AND its own TLS fingerprint for the
    // life of the session — identity and wire look stay coherent.
    maxConcurrency: 10,
    async requestHandler({ $ }) { /* ... */ },
});
```

Accepted proxy schemes: `http` (CONNECT), `socks5` (client-side DNS), `socks5h` (proxy-side DNS). An `https://` proxy scheme throws a typed `ProxyConfigError` naming the scheme — TLS-to-the-proxy is not supported by the underlying stack.

### Profile selection

```ts
import { BrowsersmithHttpClient } from "@browsercore/crawlee";

// Pin one profile for every request (wins over session fingerprints):
new BrowsersmithHttpClient({ profile: "firefox-128" });

// Or follow each session's fingerprint (default "auto"):
//   fingerprint.browser "firefox" → firefox-128
//   fingerprint.browser "safari" → safari-18
//   "chrome" / "edge" / no fingerprint → chrome-140
new BrowsersmithHttpClient({ profile: "auto" });
```

This mirrors `ImpitHttpClient`'s override precedence: an explicit profile wins over the session, and Chromium-based families collapse onto Chrome. Any profile id in the browsersmith registry is accepted (`safari-18`, `edge-128`, …) and is validated at construction with the registry's own typed error.

## The contract

`BrowsersmithHttpClient` extends `@crawlee/http-client`'s `BaseHttpClient`, whose concrete `sendRequest` owns redirect handling (manual-mode loop, 10-hop cap, 301/302-POST→GET and 303 semantics, cross-origin credential stripping) and cookie interchange (session jar → `cookie` header per hop; response `Set-Cookie` → jar). This package implements the single abstract primitive, `fetch`, mapping the `CustomFetchOptions` the base hands in:

| Option | Mapping |
| --- | --- |
| `proxyUrl` | `parseProxyUrl` → browsersmith's tunnel (`http` / `socks5` / `socks5h`; `https` scheme → typed `ProxyConfigError` naming the scheme) |
| `fingerprint.browser` | profile: `firefox` → `firefox-128`, `safari` → `safari-18`, `chrome`/`edge`/missing → `chrome-140`; an explicit `profile` option wins |
| `cookieJar` | not forwarded — Crawlee's async jar and browsersmith's sync jar are incompatible objects, so cookies interchange as HTTP headers (see below) |
| `ignoreTlsErrors` | typed `IgnoreTlsErrorsUnsupportedError` — browsersmith performs real certificate-validating handshakes and cannot skip verification |
| `signal` | forwarded; the signal owns the deadline (the wall-clock timer is set past any practical crawl length, mirroring impit's `timeout: null` signal mode) |

**Cookie interop strategy** (mirroring the impit-client division of labor): Crawlee's `BaseHttpClient` applies the session jar to the request's `cookie` header before the request reaches this client, and the header is forwarded verbatim. On the response side, fetch 0.2.21 exposes every wire `Set-Cookie` via `fetchResponse.getSetCookie()`; the wrapper rebuilds WHATWG `Headers` from the pair list (duplicates preserved), so `BaseHttpClient` harvests **all** of them into the session jar — multi-cookie responses land with full fidelity, no side channel. The client-level jar handed to browsersmith is an `InertCookieJar`: browsersmith's own cookie engine stays out of the cookie path (its default jar would otherwise store response cookies and overwrite the header Crawlee's session applied on subsequent requests).

**Response fidelity**: the wrapper (`ResponseWithUrl`) preserves status, status text, final URL, all headers (every `Set-Cookie` value in wire order), and the fully decompressed body, so redirect resolution and cookie harvesting see exactly what the wire produced.

One browsersmith `FetchClient` per client instance; no additional queuing — Crawlee owns concurrency.

## Public API

| Export | Kind | Purpose |
| --- | --- | --- |
| `BrowsersmithHttpClient` | class | The Crawlee HTTP client (extends `BaseHttpClient`) |
| `BrowsersmithHttpClientOptions` | interface | `profile` (`ProfileId \| "auto"`), `timeoutMs`, `maxRedirects`, `ignoreTlsErrors`, `logger`, `platform`, `transportFactory` |
| `ProfileSelection` | type alias | `ProfileId \| "auto"` |
| `InertCookieJar` | class | The stateless jar handed to browsersmith — keeps its cookie engine out of Crawlee's cookie path |
| `resolveProfileId()` | function | Pure fingerprint → profile mapping |
| `toCrawleeResponse()` | function | FetchResponse → `ResponseWithUrl` wrapping |
| `BrowsersmithHttpClientError` | class | Base typed error (`kind` + `details` + `cause`) |
| `IgnoreTlsErrorsUnsupportedError` | class | `ignoreTlsErrors` requested — browsersmith cannot skip certificate validation |
| `UnsupportedHttpMethodError` | class | Method outside GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| `FetchError`, `FetchProxyError`, `FetchTimeoutError`, `RedirectError`, `ProtocolError`, `ProxyConfigError`, `UnknownProfileError` | classes | Re-exported underlying-stack errors — match without importing browsersmith directly |

## Limitations

- **No `http://` origins on the real dial.** browsersmith always negotiates TLS (real path: TCP → TLS → ALPN h2/http1.1). Plain-HTTP targets need the `transportFactory` test seam (see the options docs); the seam speaks HTTP/1.1 to whatever transport you inject.
- **`ignoreTlsErrors` is a typed error, not a silent downgrade.** browsersmith performs real certificate-validating handshakes — a request that skips verification would not produce a browser fingerprint worth impersonating, so the flag is rejected with `IgnoreTlsErrorsUnsupportedError` instead of silently downgrading security. A MITM proxy's certificate breaks exactly that fingerprint; use `ImpitHttpClient` if you need MITM support.
- **`https://` proxy scheme unsupported.** Tunneling through a TLS-encrypted proxy is not modeled by the underlying stack (`http` CONNECT, `socks5`, `socks5h` are); the scheme is rejected with a typed `ProxyConfigError` naming it.
- **Supported methods**: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS — browsersmith's `FetchMethod` union; anything else throws `UnsupportedHttpMethodError` instead of sending an unvalidated wire method.

## Verification

Three layers prove the two properties this package exists for — *behaves like crawlee's stock HTTP clients* and *the wire fingerprint stays browser-identical* — and both are wired into CI as merge gates.

### Layer 1 — Conformance suite (`tests/conformance/`, offline, in CI)

Local `node:http` fixture servers drive a **real `CheerioCrawler`** and direct `sendRequest` calls through `BrowsersmithHttpClient`, with a **twin test using crawlee's stock `FetchHttpClient` (undici) against the SAME fixture** for every scenario. A scenario passes when both clients produce the same observable behavior (status, body, redirect chain, cookie-jar contents) — that equivalence is the evidence. The matrix mirrors crawlee's own `BaseHttpClient` contract tests (Apache-2.0; scenario origins cited per file):

| Scenario | Stock-client twin |
| --- | --- |
| 301/302/303/307/308 semantics — incl. 303 POST→GET + body drop, non-POST body replay, multi-hop chains | yes |
| Cross-origin redirect credential stripping; same-origin credentials kept | yes |
| Cookie interop both directions — jar → `cookie` header, multi `Set-Cookie` → jar (getSetCookie path), merge precedence, redirect-hop jar updates | yes |
| Timeout + AbortSignal abort (pre-aborted, mid-request, timeoutMillis) | yes |
| Connection-refused → crawler-classified retryable error + clean final failure | yes |
| HEAD requests | yes |
| Keep-alive reuse across sequential requests | yes |
| gzip/br round-trip | undici yes; browsersmith request-side asserted, response-side real-path only (see note) |
| `proxyUrl` mapping — `http` CONNECT + `socks5h` through local in-process proxies; bad scheme → typed `ProxyConfigError` | N/A — `FetchHttpClient` documents itself as not supporting proxying |
| End-to-end `CheerioCrawler` redirect chains + session-cookie carry | yes |

> **gzip note:** the offline fixtures reach browsersmith through its `transportFactory` seam, whose HTTP/1.1 branch does not thread a decompression provider (`establishHttp1OverTransport`, @browsercore/fetch 0.2.21) — so response-side decompression for browsersmith is proven on the real TLS path (which does thread it) by the live integration suite against real gzip-served pages. The request side (browser `accept-encoding` profile) is asserted offline.

Run: `npm test` (fully offline, deterministic — the crawler scenarios use in-memory storage and isolated session pools).

### Layer 2 — Fingerprint parity (offline in CI + a one-request live gate in CI)

- **Offline** (`tests/fingerprint-parity.test.ts`, part of `npm test`): drives the real client dial (`createClient`, chrome-140) against a capturing TCP sink and asserts the captured ClientHello hashes to the **exact real-Chrome golden JA4** `t13d1516h2_8daaf6152771_d8a2da3f94cd` (real Chrome 146 via tls.browserleaks.com, 2026-10-31 — the same pin browsersmith's own suite holds), plus the extension set, SNI and ALPN; and drives the real HTTP/2 connection stack over an in-memory transport (mirroring @browsercore/testing's emission tests) asserting the Akamai h2 golden `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p` piece by piece: SETTINGS bytes and order, connection WINDOW_UPDATE 15663105, HEADERS flags `0x25` + priority block, pseudo-header order `m,a,s,p`, **no `host` field**, `priority: u=0, i`, profile-driven `accept-encoding`.
- **Live** (`tests/fingerprint-parity.live.test.ts`, CI step after the unit suite): **one** request per run to `https://tls.peet.ws/api/all` (the fingerprint echo oracle) through a real `BrowsersmithHttpClient` dial, asserting the oracle reports exactly the golden JA4 and the golden Akamai h2 string — no prefix matching, no tail drift. One retry on failure (still ≤2 requests per CI run — polite usage). A failure means the wire is no longer browser-identical and blocks the merge.

Run locally: `npm run test:fingerprint-live` (or `FINGERPRINT_LIVE=1` / `BROWSERSMITH_CRAWLEE_LIVE=1`).

### Layer 3 — Blocking canary (`tests/blocking-canary.live.test.ts`, NOT in CI)

A runnable comparison artifact for manual/scheduled runs: **two** requests to `tls.peet.ws/api/all` — one through Node's default client (`fetch`/undici, the stack `FetchHttpClient` uses) and one through `BrowsersmithHttpClient` — printing the observed JA4 + Akamai h2 fingerprints side by side. The only hard assertions are on our side (the exact goldens); undici's non-browser fingerprint is *documented, not asserted* — coupling the suite to Node's TLS build would be exactly the kind of flaky claim the canary exists to avoid.

```bash
npm run canary
```

How to read it: the browsersmith column must show the golden browser values (that is the anti-blocking property, live). The undici column will show a stock-runtime JA4 (different cipher/extension set) — that contrast is the point: same endpoint, same moment, browser-identical versus runtime-default.

## Package dependencies

```
@browsercore/crawlee
├── browsersmith            (the full browser-identical networking stack)
│     └── @browsercore/transport, fetch, http1, http2, tls, proxy, cookies, profiles, …
├── @browsercore/transport  (typed Transport for the test seam)
└── @crawlee/http-client    (peer — BaseHttpClient contract)
```

Zero native dependencies — the TLS stack is pure TypeScript over Node's crypto primitives.

## Position in BrowserCore

```
Crawlee (CheerioCrawler / HttpCrawler / BasicCrawler)
      │  httpClient option
 @browsercore/crawlee   ← this package (BaseHttpClient adapter)
      │
 browsersmith (TLS + HTTP/2 + HTTP/1.1 + cookies + proxy tunnels)
      │
 TCP
```


## Contributing

Contributions are welcome — bug reports, reproductions, docs and code alike. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the full guide lives in the [browsersmith repo](https://github.com/jverneuer/browsersmith/blob/main/CONTRIBUTING.md). First timer? Check the [`good first issue`](https://github.com/jverneuer/browsercore-crawlee/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Security issues: [SECURITY.md](SECURITY.md), never a public issue.

## License

MIT
