/**
 * Shared test scaffolding: a plain-HTTP test server plus the transport seam
 * that lets {@link BrowsersmithHttpClient} speak to it.
 *
 * browsersmith's real dial always negotiates TLS, so unit tests exercise the
 * stack through `transportFactory` — the documented test seam of
 * `@browsercore/fetch` — backed by real TCP transports from
 * `@browsercore/transport` speaking to a real `node:http` server. Everything
 * above the transport (dispatch, profiles, cookies, response building, and
 * this package's mapping/wrapping) runs for real.
 */

import http from "node:http";
import { connect } from "@browsercore/transport";
import type { CookieJar, SessionFingerprint } from "@crawlee/types";
import {
    nodeDns,
    nodeEventProvider,
    nodeNet,
} from "browsersmith";
import type { BrowsersmithHttpClientOptions } from "../src/index.js";
import { BrowsersmithHttpClient } from "../src/index.js";

/** Minimal session stub covering what BaseHttpClient reads from a session. */
export interface FakeSession {
    readonly cookieJar?: CookieJar;
    readonly fingerprint?: SessionFingerprint;
    readonly proxyInfo?: {
        readonly url?: string;
        readonly ignoreTlsErrors?: boolean;
        readonly hostname?: string;
        readonly port?: number;
    };
}

/** Handler signature the test server dispatches on. */
export type TestServerHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
) => void | Promise<void>;

/** A started test server. */
export interface TestServer {
    readonly port: number;
    /** Every request the server has seen, in wire order. */
    readonly seenRequests: SeenRequest[];
    close(): Promise<void>;
}

/** What the server recorded about one request. */
export interface SeenRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: http.IncomingHttpHeaders;
    /** Filled progressively: "" until the request "end" event lands. */
    body: string;
}

/**
 * Ports used by recent servers in this process. Rapid sequential tests can
 * make the OS hand the just-released port back to the next `listen(0)`, and
 * the new connection then shares its 4-tuple with the previous test's
 * lingering (RST-ing) socket — the fresh request dies with ECONNRESET before
 * the server sees a byte. Avoiding recent ports removes the collision.
 */
const recentServerPorts = new Set<number>();

/** Start a plain-HTTP server on 127.0.0.1:0 with per-path handlers. */
export async function startTestServer(
    handlers: Record<string, TestServerHandler>,
    fallback?: TestServerHandler,
): Promise<TestServer> {
    let server = await listenOnFreePort();
    // Re-listen until the port differs from anything used recently.
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const address = server.address();
        const port = address !== null && typeof address !== "string" ? address.port : 0;
        if (port !== 0 && !recentServerPorts.has(port)) {
            recentServerPorts.add(port);
            if (recentServerPorts.size > 16) {
                // Bound the set: only recent collisions matter.
                const oldest = recentServerPorts.values().next().value;
                if (oldest !== undefined) {
                    recentServerPorts.delete(oldest);
                }
            }
            return buildTestServer(server, port, handlers, fallback);
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        server = await listenOnFreePort();
    }
    // Fall through with whatever port we got rather than failing the suite.
    const address = server.address();
    const port = address !== null && typeof address !== "string" ? address.port : 0;
    return buildTestServer(server, port, handlers, fallback);
}

function listenOnFreePort(): Promise<http.Server> {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

function buildTestServer(
    server: http.Server,
    port: number,
    handlers: Record<string, TestServerHandler>,
    fallback?: TestServerHandler,
): TestServer {
    const seenRequests: SeenRequest[] = [];
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
        // Record in parallel with the handler: attaching these listeners does
        // not consume the stream, so handlers that read the body themselves
        // still observe `data`/`end`.
        const chunks: Buffer[] = [];
        const seen: SeenRequest = {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: req.headers,
            body: "",
        };
        seenRequests.push(seen);
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            seen.body = Buffer.concat(chunks).toString("utf8");
        });
        const handler = handlers[seen.url] ?? fallback;
        if (handler === undefined) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
            return;
        }
        void Promise.resolve(handler(req, res)).catch((err: Error) => {
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain" });
            }
            res.end(`handler error: ${err.message}`);
        });
    });
    return {
        port,
        seenRequests,
        close: async () => {
            // Keep-alive pool sockets must not block server teardown.
            server.closeIdleConnections();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}

/**
 * A `transportFactory` that records the endpoint it was asked to dial (the
 * proxy's when a request is proxied, otherwise the origin's) and then
 * connects to the given real server, so the request itself completes.
 */
export function recordingTransportFactory(
    server: TestServer,
): {
    readonly factory: NonNullable<BrowsersmithHttpClientOptions["transportFactory"]>;
    readonly dialed: { host: string; port: number }[];
} {
    const dialed: { host: string; port: number }[] = [];
    const factory = async (host: string, port: number) => {
        dialed.push({ host, port });
        return connect({
            host: "127.0.0.1",
            port: server.port,
            net: nodeNet,
            dns: nodeDns,
            // The shared provider — the real-world path. transport 0.2.8
            // scopes transport events, so sharing is safe; the passing suite
            // doubles as the isolation regression guard. (crypto/compression
            // are not TransportOptions members — the TCP dialer never was
            // their consumer.)
            events: nodeEventProvider,
        });
    };
    return { factory, dialed };
}

/** Build a client wired to the test server through the transport seam. */
export function clientForServer(
    server: TestServer,
    options: Omit<BrowsersmithHttpClientOptions, "transportFactory" | "platform"> = {},
): BrowsersmithHttpClient {
    const { factory } = recordingTransportFactory(server);
    return new BrowsersmithHttpClient({
        ...options,
        transportFactory: factory,
    });
}
