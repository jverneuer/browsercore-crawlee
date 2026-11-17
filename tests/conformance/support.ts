/**
 * Shared harness for the conformance suite (tests/conformance/*.test.ts).
 *
 * Every scenario runs against the SAME local fixture servers for BOTH HTTP
 * clients under test:
 *
 * - `"browsersmith"` — this package's {@link BrowsersmithHttpClient}, wired to
 *   the fixture through the documented `transportFactory` seam (browsersmith's
 *   real dial always negotiates TLS, so plain-`http://` fixtures are reached
 *   by injecting the transport — everything above it runs for real).
 * - `"undici"` — crawlee's stock `FetchHttpClient` (native fetch / undici),
 *   the reference `BaseHttpClient` implementation crawlee ships.
 *
 * A scenario passes conformance when both clients produce the same observable
 * behavior (status, body, redirect chain, cookie jar contents) on the same
 * fixture — that equivalence is the "behaves like crawlee's stock clients"
 * evidence this suite exists to produce.
 *
 * Scenario origins (Apache-2.0, apify/crawlee): the matrix mirrors
 * `test/core/base-http-client.test.ts`, `test/core/impit-http-client.test.ts`,
 * and `packages/cheerio-crawler` fixture-server patterns. The code is ours.
 */

import * as http from "node:http";
import * as net from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Duplex } from "node:stream";
import { CheerioCrawler, Configuration, MemoryStorageBackend, RequestQueue, SessionPool, serviceLocator } from "crawlee";
import type { BaseHttpClient } from "@crawlee/http-client";
import { FetchHttpClient } from "@crawlee/http-client";
import type { CloseReason, Transport, TransportId, TransportState } from "@browsercore/transport";
import { connect as connectTransport } from "@browsercore/transport";
import type { TestServer } from "../helpers.js";
import { startTestServer } from "../helpers.js";
import { BrowsersmithHttpClient } from "../../src/index.js";
import type { BrowsersmithHttpClientOptions } from "../../src/index.js";
import { nodeCompression, nodeCryptoProvider, nodeDns, nodeEventProvider, nodeNet } from "browsersmith";

/** The two clients every conformance scenario runs against. */
export const CLIENT_KINDS = ["browsersmith", "undici"] as const;

/** @see {@link CLIENT_KINDS} */
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** A constructed client plus its cleanup — `close` is a no-op for stock clients. */
export interface ClientHandle {
    readonly kind: ClientKind;
    readonly client: BaseHttpClient;
    close(): Promise<void>;
}

/**
 * Build the client under test wired to a fixture server.
 *
 * The browsersmith client's transport factory connects to the DIALED port on
 * 127.0.0.1 (not a fixed one), so multi-server fixtures — e.g. a redirector on
 * one port and a cross-origin target on another — route correctly for both
 * clients.
 */
export function clientFor(
    kind: ClientKind,
    server: TestServer,
    options: BrowsersmithHttpClientOptions = {},
): ClientHandle {
    if (kind === "undici") {
        return {
            kind,
            client: new FetchHttpClient(),
            close: async () => {
                // Undici keeps global agents; the stock client needs no teardown.
            },
        };
    }
    const client = new BrowsersmithHttpClient({
        ...options,
        transportFactory: async (host, port) => {
            void host; // Routing is by port; the dialed hostname is asserted by the proxy scenarios.
            return connectTransport({
                host: "127.0.0.1",
                port,
                net: nodeNet,
                dns: nodeDns,
                events: nodeEventProvider,
                crypto: nodeCryptoProvider,
                compression: nodeCompression,
            });
        },
    });
    return { kind, client, close: () => client.close() };
}

/**
 * A FRESH crawler configuration per crawl: in-memory storage so the
 * CheerioCrawler scenarios never touch `./storage` (CI runs the suite on
 * every push; a filesystem-backed run would leave artifacts and slow the
 * job), and never shared between crawls — crawlee's `purgeOnStart` default
 * wipes the storage a second crawler would still be writing into, silently
 * dropping its requests.
 */
/**
 * Point crawlee's GLOBAL service locator at an in-memory storage backend.
 *
 * Why global and not just per-crawler `configuration`: the crawler's OWN
 * default request queue is opened through `serviceLocator.getConfiguration()`
 * (basic-crawler's `#openOwnedRequestQueue`) — NOT the crawler's
 * configuration option — so without this, every crawler lands in the
 * on-disk `./storage` under `__default_N__` aliases that collide across
 * concurrently running test files (vitest workers), silently dropping
 * requests. Each worker imports this module once, so each gets its own
 * backend: fully isolated, zero disk artifacts.
 */
serviceLocator.setConfiguration(new Configuration({ storageClient: new MemoryStorageBackend() }));

export function freshCrawlerConfiguration(): Configuration {
    return new Configuration({ storageClient: new MemoryStorageBackend() });
}

/**
 * A single-session pool with persistence DISABLED. Two isolation reasons:
 * crawlee's default pool hands sequential requests different sessions (which
 * would defeat the session-jar cookie scenario — cookies land in session A,
 * request 2 reads session B), and a directly-constructed SessionPool
 * persists its state through the GLOBAL service locator — the on-disk
 * `./storage` — which concurrent test processes stomp on.
 */
export function isolatedSessionPool(): SessionPool {
    return new SessionPool({ maxPoolSize: 1, persistenceOptions: { enable: false } });
}

/** What the `/echo` fixture reports about one request (JSON body). */
export interface EchoBody {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
}

/** Header names the WHATWG layer keeps; everything node records is lowercase. */
function recordedHeaders(req: http.IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) {
            continue;
        }
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

/** The standard echo handler — reflects method, url, headers, and body back as JSON. */
export function echoHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
        const echo: EchoBody = {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: recordedHeaders(req),
            body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(echo));
    });
}

/**
 * The conformance fixture server: `/echo` plus the redirect, cookie,
 * compression, slow-response, and HTML endpoints the scenarios dispatch on.
 *
 * Redirect targets are absolute or path URLs taken from the `to` query
 * parameter — the scenarios pass cross-origin (`http://localhost:port/echo`)
 * or same-origin (`/echo`) targets exactly like crawlee's own base-client
 * tests distinguish them.
 */
export async function startConformanceServer(): Promise<TestServer> {
    const page = (title: string, body: string): readonly [string, string] => [
        `<html><head><title>${title}</title></head><body>${body}</body></html>`,
        "text/html; charset=utf-8",
    ];
    const [landingHtml, landingType] = page("conformance landing", "<p id=\"marker\">landing</p>");
    const [cookieEchoHtml, cookieEchoType] = page("cookie echo", "<p id=\"saw\"></p>");
    // The dispatch is on PATHNAME only — several endpoints carry query
    // parameters (?status=&to=, ?enc=, ?ms=) that must not break routing.
    const route = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        const url = new URL(req.url ?? "/", "http://fixture.local");
        switch (url.pathname) {
            case "/echo":
                echoHandler(req, res);
                return;
            case "/page":
                res.writeHead(200, { "content-type": landingType });
                res.end(landingHtml);
                return;
            case "/redirect": {
                const status = Number(url.searchParams.get("status"));
                const target = url.searchParams.get("to") ?? "/echo";
                req.resume();
                res.writeHead(status, { location: target });
                res.end();
                return;
            }
            // A redirecting endpoint that ALSO sets a cookie — crawlee's own
            // base tests use this shape to prove the jar updates mid-chain.
            case "/redirect-set-cookie":
                req.resume();
                res.writeHead(302, { location: "/echo", "set-cookie": "session=new" });
                res.end();
                return;
            case "/set-cookie":
                // Multi Set-Cookie: exercises the getSetCookie harvest path.
                res.writeHead(200, {
                    "content-type": "text/plain",
                    "set-cookie": ["first=1; Path=/", "second=2; Path=/", "third=3; Path=/"],
                });
                res.end("cookies set");
                return;
            case "/cookie-drop":
                res.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                    "set-cookie": ["dropped=a; Path=/", "dropped2=b; Path=/"],
                });
                res.end(landingHtml);
                return;
            case "/cookie-echo": {
                // Escape the cookie string so it survives Cheerio parsing.
                const escaped = (req.headers.cookie ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const html = cookieEchoHtml.replace("<p id=\"saw\"></p>", `<p id="saw">${escaped}</p>`);
                res.writeHead(200, { "content-type": cookieEchoType });
                res.end(html);
                return;
            }
            case "/compressed": {
                const encoding = url.searchParams.get("enc") ?? "gzip";
                const payload = Buffer.from("compressed fixture body — round-trips through content-encoding", "utf8");
                const body = encoding === "br" ? brotliCompressSync(payload) : gzipSync(payload);
                res.writeHead(200, { "content-type": "text/plain", "content-encoding": encoding });
                res.end(body);
                return;
            }
            case "/slow": {
                const delayMs = Number(url.searchParams.get("ms") ?? "500");
                req.resume();
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("late");
                }, delayMs);
                return;
            }
            default:
                res.writeHead(404, { "content-type": "text/plain" });
                res.end("not found");
        }
    };
    return startTestServer({}, route);
}

/** A loopback origin string for a fixture server, on a chosen hostname. */
export function originOf(server: TestServer, hostname: "127.0.0.1" | "localhost" = "127.0.0.1"): string {
    return `http://${hostname}:${server.port}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local in-process proxies (proxyUrl mapping scenarios)
// ─────────────────────────────────────────────────────────────────────────────

/** What a local proxy observed — the assertions' observables. */
export interface ProxyObservations {
    /** CONNECT targets ("host:port") the HTTP proxy tunnelled, in order. */
    readonly connectTargets: readonly string[];
    /** SOCKS5 DOMAINNAME requests ("host:port") the SOCKS server relayed. */
    readonly domainTargets: readonly string[];
}

/** A started local proxy: its port plus the recorded observations. */
export interface LocalProxy {
    readonly port: number;
    readonly observations: ProxyObservations;
    close(): Promise<void>;
}

/** Stop an `http.Server`/`net.Server` without letting pooled sockets stall it. */
async function closeServer(server: http.Server | net.Server): Promise<void> {
    if (server instanceof http.Server) {
        server.closeIdleConnections();
    } else {
        server.closeAllConnections?.();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Minimal in-process HTTP CONNECT proxy (scenario origin: browsersmith
 * `examples/proxy-fetch.ts`'s in-process proxy pattern). Every tunnel is
 * piped raw to the dialed target — the request bytes a detector would see
 * ride the tunnel unchanged.
 */
export async function startConnectProxy(): Promise<LocalProxy> {
    const connectTargets: string[] = [];
    const server = http.createServer();
    server.on("connect", (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
        const target = req.url ?? "";
        connectTargets.push(target);
        const colonAt = target.lastIndexOf(":");
        if (colonAt < 1) {
            clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
            return;
        }
        const upstream = net.connect(Number(target.slice(colonAt + 1)), target.slice(0, colonAt));
        upstream.on("connect", () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
        clientSocket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = address !== null && typeof address !== "string" ? address.port : 0;
    return { port, observations: { connectTargets, domainTargets: [] }, close: () => closeServer(server) };
}

/**
 * Minimal in-process SOCKS5 server (RFC 1928): no-auth greeting, then
 * CMD=CONNECT with ATYP=DOMAINNAME (the "socks5h" remote-DNS shape) relayed
 * to the dialed target. Bytes after the reply are piped raw.
 */
export async function startSocks5Server(): Promise<LocalProxy> {
    const domainTargets: string[] = [];
    const server = net.createServer((socket) => {
        // Stage 1 — greeting: VER=5, NMETHODS, METHODS… → reply no-auth.
        // Stage 2 — CONNECT request: VER CMD RSV ATYP=DOMAINNAME ADDR PORT.
        // Stage 3 — raw relay in both directions (the client's HTTP bytes).
        // The client handshake is strictly sequential (each stage awaits the
        // previous reply), so each stage owns exactly one chunk.
        const onRequest = (chunk: Buffer): void => {
            socket.off("data", onRequest);
            if (chunk[0] !== 0x05 || chunk[1] !== 0x01 || chunk[3] !== 0x03) {
                socket.destroy();
                return;
            }
            const nameLength = chunk[4] ?? 0;
            const host = chunk.subarray(5, 5 + nameLength).toString("utf8");
            const port = (chunk[5 + nameLength]! << 8) | chunk[6 + nameLength]!;
            domainTargets.push(`${host}:${port}`);
            const upstream = net.connect(port, "127.0.0.1");
            // Reply: VER REP=0 RSV ATYP=IPV4 ADDR=0.0.0.0 PORT=0 (binding is
            // meaningless for a relay; clients only check REP=0).
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            // Bytes arriving between the reply and the upstream connect are
            // buffered by node (no 'data' listener attached) and flush
            // through the pipe once it is established.
            upstream.on("connect", () => {
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.on("error", () => socket.destroy());
            socket.on("error", () => upstream.destroy());
        };
        const onGreeting = (chunk: Buffer): void => {
            if (chunk[0] !== 0x05) {
                socket.destroy();
                return;
            }
            socket.off("data", onGreeting);
            socket.write(Buffer.from([0x05, 0x00]));
            socket.on("data", onRequest);
        };
        socket.on("data", onGreeting);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = address !== null && typeof address !== "string" ? address.port : 0;
    return { port, observations: { connectTargets: [], domainTargets }, close: () => closeServer(server) };
}

/**
 * A transport factory that performs the REAL proxy handshake against a local
 * proxy — CONNECT for `http` scheme, the SOCKS5h no-auth DOMAINNAME greeting
 * for `socks5h` — and bridges the tunnelled socket into the Transport the
 * browsersmith client expects.
 *
 * Why the origin comes from the caller: the transport seam is dialed with the
 * PROXY's endpoint only (on the real path, `openProxiedTransport` learns the
 * origin from the request URL — an API the seam does not carry). The test
 * closure, which knows the fixture origin, fills that role. What this proves
 * end-to-end: the adapter's proxyUrl mapping (the dial arrives at the proxy's
 * endpoint — recorded in {@link TunnelHarness.dialed}), the proxy handshake
 * bytes, and the request completing through a real tunnelled relay.
 */
export function tunnellingTransportFactory(
    proxy: LocalProxy,
    scheme: "http" | "socks5h",
    originHost: string,
    originPort: number,
): TunnelHarness {
    const dialed: { host: string; port: number }[] = [];
    const factory = async (host: string, port: number): Promise<Transport> => {
        dialed.push({ host, port });
        const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        if (scheme === "http") {
            await performConnectHandshake(socket, originHost, originPort);
        } else {
            await performSocks5hHandshake(socket, originHost, originPort);
        }
        return adaptSocket(socket);
    };
    return { factory, dialed };
}

/** A tunnelling factory plus the proxy-endpoint dials it recorded. */
export interface TunnelHarness {
    readonly factory: NonNullable<BrowsersmithHttpClientOptions["transportFactory"]>;
    readonly dialed: readonly { host: string; port: number }[];
}

/** Issue `CONNECT host:port` and await the 2xx tunnel-established response. */
function performConnectHandshake(socket: net.Socket, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
        let seen = "";
        const onData = (chunk: Buffer): void => {
            seen += chunk.toString("utf8");
            if (seen.includes("\r\n\r\n")) {
                socket.off("data", onData);
                if (/^HTTP\/1\.[01] 2/.test(seen)) {
                    resolve();
                } else {
                    reject(new Error(`proxy refused CONNECT: ${seen.split("\r\n")[0]}`));
                }
            }
        };
        socket.on("data", onData);
        socket.once("error", reject);
    });
}

/** SOCKS5 no-auth greeting + CMD=CONNECT with ATYP=DOMAINNAME (the socks5h shape). */
function performSocks5hHandshake(socket: net.Socket, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(Buffer.from([0x05, 0x01, 0x00])); // VER, 1 method, no-auth
        let stage: "greeting" | "request" = "greeting";
        const hostBytes = Buffer.from(host, "utf8");
        const onData = (chunk: Buffer): void => {
            if (stage === "greeting") {
                if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
                    socket.off("data", onData);
                    reject(new Error("socks5 server rejected no-auth"));
                    return;
                }
                stage = "request";
                const request = Buffer.alloc(7 + hostBytes.length);
                request[0] = 0x05; // VER
                request[1] = 0x01; // CMD CONNECT
                request[2] = 0x00; // RSV
                request[3] = 0x03; // ATYP DOMAINNAME
                request[4] = hostBytes.length;
                request.set(hostBytes, 5);
                request.writeUInt16BE(port, 5 + hostBytes.length);
                socket.write(request);
                return;
            }
            socket.off("data", onData);
            if (chunk[0] === 0x05 && chunk[1] === 0x00) {
                resolve();
            } else {
                reject(new Error(`socks5 connect failed: REP=${chunk[1]}`));
            }
        };
        socket.on("data", onData);
        socket.once("error", reject);
    });
}

/** Sequence counter for tunnel transport ids. */
let tunnelCounter = 0;

/**
 * Adapt an established tunnel socket into the `Transport` surface the HTTP
 * layer consumes (the same adapter model browsersmith's own test fixtures
 * use for loopback sockets).
 */
function adaptSocket(socket: net.Socket): Transport {
    const queued: Uint8Array[] = [];
    const waiters: Array<(chunk: Uint8Array) => void> = [];
    const rejectors: Array<(error: Error) => void> = [];
    let stateValue: TransportState = { state: "open" };
    socket.on("data", (chunk: Buffer) => {
        const bytes = new Uint8Array(chunk);
        const waiter = waiters.shift();
        if (waiter === undefined) {
            queued.push(bytes);
        } else {
            waiter(bytes);
        }
    });
    socket.on("close", () => {
        stateValue = { state: "closed", reason: { kind: "remote_close" } };
        for (const reject of rejectors.splice(0)) {
            reject(new Error("tunnel closed"));
        }
    });
    socket.on("error", () => socket.destroy());
    tunnelCounter += 1;
    return {
        id: `conformance-tunnel-${tunnelCounter}` as TransportId,
        get state() {
            return stateValue;
        },
        write: (data) =>
            new Promise<void>((resolve, reject) => {
                socket.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
            }),
        read: () => {
            const chunk = queued.shift();
            if (chunk !== undefined) {
                return Promise.resolve(chunk);
            }
            return new Promise<Uint8Array>((resolve, reject) => {
                waiters.push(resolve);
                rejectors.push(reject);
            });
        },
        close: (reason?: CloseReason) => {
            stateValue = { state: "closed", reason: reason ?? { kind: "client_close" } };
            socket.destroy();
            return Promise.resolve();
        },
        on: (event, listener) => {
            socket.on(event, listener as never);
        },
        once: (event, listener) => {
            socket.once(event, listener as never);
        },
    };
}

/** Read a JSON response body from a crawlee `Response`. */
export async function readJsonBody(response: Response): Promise<EchoBody> {
    return (await response.json()) as EchoBody;
}

/** What a CheerioCrawler run observed — the crawler-integration twins' observable. */
export interface CrawlerObservation {
    readonly statuses: number[];
    readonly loadedUrls: string[];
    readonly titles: string[];
    readonly cookieEchoes: string[];
}

/**
 * Run one CheerioCrawler over the given URLs with the given client kind and
 * collect what the requestHandler observed. Both clients drive the identical
 * crawler shape (memory storage, no retries, single concurrency) so their
 * observations are directly comparable.
 */
export async function crawlWith(
    kind: ClientKind,
    urls: readonly string[],
    fixture: TestServer,
): Promise<CrawlerObservation> {
    const handle = clientFor(kind, fixture);
    const statuses: number[] = [];
    const loadedUrls: string[] = [];
    const titles: string[] = [];
    const cookieEchoes: string[] = [];
    // An explicit, uniquely-named memory-backed request queue as the request
    // manager: without one, the crawler opens its default request queue
    // through the GLOBAL service locator (see the setConfiguration note
    // above), and the first crawler in a worker reuses the shared "default"
    // queue — which concurrent test workers then purge out from under each
    // other (crawlee's purgeOnStart).
    const requestManager = await RequestQueue.open(`conformance-${queueCounter.next().value}`, {
        configuration: freshCrawlerConfiguration(),
    });
    const sessionPool = isolatedSessionPool();
    const crawler = new CheerioCrawler({
        configuration: freshCrawlerConfiguration(),
        httpClient: handle.client,
        sessionPool,
        requestManager,
        maxRequestRetries: 0,
        maxConcurrency: 1,
        navigationTimeoutSecs: 30,
        async requestHandler({ response, $, request }) {
            statuses.push(response?.status ?? 0);
            loadedUrls.push(request.loadedUrl ?? "");
            titles.push($("title").first().text().trim());
            cookieEchoes.push($("#saw").first().text().trim());
        },
    });
    try {
        await crawler.run([...urls]);
    } finally {
        await handle.close();
        await sessionPool.teardown();
    }
    return { statuses, loadedUrls, titles, cookieEchoes };
}

/** Per-process queue-name counter — unique names keep concurrent crawls' queues disjoint. */
const queueCounter: IterableIterator<number> = (function* counter(): Generator<number> {
    for (let i = 1; ; i += 1) {
        yield i;
    }
})();
