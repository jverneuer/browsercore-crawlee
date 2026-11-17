/**
 * Wire-level behavior of BrowsersmithHttpClient against a real HTTP server.
 *
 * The transport seam (see helpers.ts) stands in for the TCP+TLS dial, so
 * everything above it — this package's CustomFetchOptions mapping, the
 * browsersmith dispatch, profiles, cookies, and the Response wrapping — is
 * exercised for real.
 */

import { describe, expect, it } from "vitest";
import { CookieJar as ToughCookieJar } from "tough-cookie";
import { PROFILES } from "browsersmith";
import type { ISession } from "@crawlee/types";
import {
    BrowsersmithHttpClient,
    FetchError,
    FetchTimeoutError,
    IgnoreTlsErrorsUnsupportedError,
    ProxyConfigError,
    UnsupportedHttpMethodError,
    UnknownProfileError,
} from "../src/index.js";
import {
    clientForServer,
    recordingTransportFactory,
    startTestServer,
    type TestServer,
} from "./helpers.js";

/** Test-only subclass exposing the protected `fetch` primitive directly. */
class ExposedFetchClient extends BrowsersmithHttpClient {
    public rawFetch(request: Request, init?: RequestInit): Promise<Response> {
        return this.fetch(request, init);
    }
}

describe("BrowsersmithHttpClient — response wrapping fidelity", () => {
    it("returns status, url, headers, and body faithful to the wire response", async () => {
        const server = await startTestServer({
            "/page": (_req, res) => {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-mark": "yes" });
                res.end("<html><body>wire</body></html>");
            },
        });
        const client = clientForServer(server);
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/page`),
            );
            expect(response.status).toBe(200);
            expect(response.url).toBe(`http://127.0.0.1:${server.port}/page`);
            expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
            expect(response.headers.get("x-mark")).toBe("yes");
            expect(await response.text()).toContain("wire");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("carries request method and body through to the wire", async () => {
        const server = await startTestServer({
            "/echo": (req, res) => {
                const chunks: Buffer[] = [];
                req.on("data", (c: Buffer) => chunks.push(c));
                req.on("end", () => {
                    res.writeHead(201, { "content-type": "application/json" });
                    res.end(JSON.stringify({ body: Buffer.concat(chunks).toString("utf8") }));
                });
            },
        });
        const client = clientForServer(server);
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/echo`, {
                    method: "POST",
                    body: "payload=1",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                }),
            );
            expect(response.status).toBe(201);
            const echoed = (await response.json()) as { body: string };
            expect(echoed.body).toBe("payload=1");
        } finally {
            await client.close();
            await server.close();
        }
    });
});

describe("BrowsersmithHttpClient — redirect pass-through", () => {
    it("does not follow redirects itself — manual mode returns the 3xx hop untouched", async () => {
        const server = await startTestServer({
            "/redirect": (_req, res) => {
                res.writeHead(302, { location: "/final", "set-cookie": "hop=1; Path=/" });
                res.end();
            },
            "/final": (_req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("final");
            },
        });
        const client = new ExposedFetchClient({ transportFactory: recordingTransportFactory(server).factory });
        try {
            const response = await client.rawFetch(
                new Request(`http://127.0.0.1:${server.port}/redirect`),
                { redirect: "manual" },
            );
            expect(response.status).toBe(302);
            expect(response.url).toBe(`http://127.0.0.1:${server.port}/redirect`);
            expect(response.headers.get("location")).toBe("/final");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("delegates redirect following to browsersmith when asked directly", async () => {
        const server = await startTestServer({
            "/redirect": (_req, res) => {
                res.writeHead(302, { location: "/final" });
                res.end();
            },
            "/final": (_req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("final");
            },
        });
        const client = new ExposedFetchClient({ transportFactory: recordingTransportFactory(server).factory });
        try {
            const response = await client.rawFetch(
                new Request(`http://127.0.0.1:${server.port}/redirect`),
                { redirect: "follow" },
            );
            expect(response.status).toBe(200);
            expect(response.url).toBe(`http://127.0.0.1:${server.port}/final`);
            expect(await response.text()).toBe("final");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("BaseHttpClient.sendRequest owns the redirect loop, per-hop cookies included", async () => {
        const server = await startTestServer({
            "/redirect": (_req, res) => {
                res.writeHead(302, { location: "/final", "set-cookie": "hop=1; Path=/" });
                res.end();
            },
            "/final": (_req, res) => {
                res.writeHead(200, { "content-type": "text/plain", "set-cookie": "done=1; Path=/" });
                res.end("final");
            },
        });
        const client = clientForServer(server);
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/redirect`),
            );
            expect(response.status).toBe(200);
            expect(response.url).toBe(`http://127.0.0.1:${server.port}/final`);
            expect(await response.text()).toBe("final");
            // The base harvested the redirect hop's Set-Cookie and applied it
            // to the next hop's request.
            const finalRequest = server.seenRequests.find((r) => r.url === "/final");
            expect(finalRequest?.headers.cookie).toContain("hop=1");
        } finally {
            await client.close();
            await server.close();
        }
    });
});

describe("BrowsersmithHttpClient — cookie interop", () => {
    it("request direction: a session jar's cookies ride the cookie header", async () => {
        const server = await startTestServer({
            "/who": (req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(`cookie:${String(req.headers.cookie ?? "")}`);
            },
        });
        const client = clientForServer(server);
        const jar = new ToughCookieJar();
        jar.setCookieSync("session=abc; Domain=127.0.0.1; Path=/", `http://127.0.0.1:${server.port}/`);
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/who`),
                { cookieJar: jar as unknown as import("@crawlee/types").CookieJar },
            );
            expect(await response.text()).toContain("session=abc");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("response direction: the response's Set-Cookie lands in the caller's jar", async () => {
        const server = await startTestServer({
            "/login": (_req, res) => {
                res.writeHead(200, { "set-cookie": "sid=xyz; Path=/" });
                res.end("logged in");
            },
        });
        const client = clientForServer(server);
        const jar = new ToughCookieJar();
        try {
            await client.sendRequest(new Request(`http://127.0.0.1:${server.port}/login`), {
                cookieJar: jar as unknown as import("@crawlee/types").CookieJar,
            });
            const cookies = jar.getCookiesSync(`http://127.0.0.1:${server.port}/`);
            const sid = cookies.find((c) => c.key === "sid");
            expect(sid?.value).toBe("xyz");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("header cookies and jar cookies merge on the request", async () => {
        const server = await startTestServer({
            "/who": (req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(`cookie:${String(req.headers.cookie ?? "")}`);
            },
        });
        const client = clientForServer(server);
        const jar = new ToughCookieJar();
        jar.setCookieSync("jarCookie=2; Domain=127.0.0.1; Path=/", `http://127.0.0.1:${server.port}/`);
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/who`, {
                    headers: { cookie: "headerCookie=1" },
                }),
                { cookieJar: jar as unknown as import("@crawlee/types").CookieJar },
            );
            const seen = await response.text();
            expect(seen).toContain("headerCookie=1");
            expect(seen).toContain("jarCookie=2");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("multi-cookie responses land in the session jar with full fidelity", async () => {
        // fetch 0.2.21 exposes every Set-Cookie via getSetCookie() and the
        // wrapper rebuilds WHATWG Headers from the pair list, so the base
        // class harvests ALL of them — no side channel, no last-wins loss.
        const server = await startTestServer({
            "/multi": (_req, res) => {
                res.appendHeader("set-cookie", "a=1; Path=/");
                res.appendHeader("set-cookie", "b=2; Path=/");
                res.appendHeader("set-cookie", "c=3; Path=/; Secure");
                res.writeHead(200);
                res.end("multi");
            },
        });
        const client = clientForServer(server);
        const jar = new ToughCookieJar();
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/multi`),
                { cookieJar: jar as unknown as import("@crawlee/types").CookieJar },
            );
            expect(response.headers.getSetCookie()).toEqual([
                "a=1; Path=/",
                "b=2; Path=/",
                "c=3; Path=/; Secure",
            ]);
            const names = jar.getCookiesSync(`http://127.0.0.1:${server.port}/`).map((c) => c.key).sort();
            expect(names).toEqual(["a", "b", "c"]);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("HEAD resolves immediately on a pooled connection and the connection is reusable", async () => {
        // http1 0.2.3 frames HEAD/204/304 as body-less — no close-delimiting
        // hang, no Connection: close workaround, no one-shot client.
        const server = await startTestServer({
            "/head": (_req, res) => {
                res.writeHead(200, { "x-head": "yes" });
                res.end("ignored");
            },
            "/after": (_req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("still alive");
            },
        });
        const client = clientForServer(server);
        try {
            const t0 = Date.now();
            const head = await client.sendRequest(new Request(`http://127.0.0.1:${server.port}/head`, { method: "HEAD" }));
            const headMs = Date.now() - t0;
            expect(head.status).toBe(200);
            expect(head.headers.get("x-head")).toBe("yes");
            expect(await head.text()).toBe("");
            expect(headMs).toBeLessThan(2000);
            // The pooled transport survives the HEAD — next request reuses it.
            const after = await client.sendRequest(new Request(`http://127.0.0.1:${server.port}/after`));
            expect(after.status).toBe(200);
            expect(await after.text()).toBe("still alive");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("a safari session fingerprint switches the wire profile to safari-18", async () => {
        const server = await startTestServer({
            "/who": (req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(String(req.headers["user-agent"] ?? ""));
            },
        });
        const client = clientForServer(server);
        const session = { fingerprint: { browser: "safari" } } as unknown as ISession;
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/who`),
                { session },
            );
            const userAgent = await response.text();
            expect(userAgent).toContain("Safari");
            expect(userAgent).not.toContain("Chrome/140");
        } finally {
            await client.close();
            await server.close();
        }
    });
});

describe("BrowsersmithHttpClient — proxyUrl mapping", () => {
    interface ProxyCase {
        readonly name: string;
        readonly proxyUrl: string;
        readonly expectedHost: string;
        readonly expectedPort: number;
    }

    const mappingCases: ProxyCase[] = [
        { name: "http proxy with explicit port", proxyUrl: "http://proxy.example.com:8080", expectedHost: "proxy.example.com", expectedPort: 8080 },
        { name: "socks5 with credentials", proxyUrl: "socks5://user:p%40ss@10.0.0.1:1080", expectedHost: "10.0.0.1", expectedPort: 1080 },
        { name: "socks5h default port 1080", proxyUrl: "socks5h://proxy.internal", expectedHost: "proxy.internal", expectedPort: 1080 },
        { name: "http default port 80", proxyUrl: "http://192.168.1.1", expectedHost: "192.168.1.1", expectedPort: 80 },
    ];

    for (const testCase of mappingCases) {
        it(`maps ${testCase.name} — the proxy endpoint is what gets dialed`, async () => {
            const server = await startTestServer({
                "/x": (_req, res) => {
                    res.writeHead(200);
                    res.end("ok");
                },
            });
            const { factory, dialed } = recordingTransportFactory(server);
            const client = new BrowsersmithHttpClient({ transportFactory: factory });
            try {
                const response = await client.sendRequest(
                    new Request(`http://origin.example.com/x`),
                    { proxyUrl: testCase.proxyUrl },
                );
                expect(response.status).toBe(200);
                expect(dialed).toEqual([{ host: testCase.expectedHost, port: testCase.expectedPort }]);
            } finally {
                await client.close();
                await server.close();
            }
        });
    }

    it("requests without proxyUrl dial the origin directly", async () => {
        const server = await startTestServer({
            "/x": (_req, res) => {
                res.writeHead(200);
                res.end("ok");
            },
        });
        const { factory, dialed } = recordingTransportFactory(server);
        const client = new BrowsersmithHttpClient({ transportFactory: factory });
        try {
            await client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`));
            expect(dialed).toEqual([{ host: "127.0.0.1", port: server.port }]);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("rejects https-scheme proxies with a typed error naming the scheme", async () => {
        const server = await startTestServer({ "/x": () => undefined });
        const client = clientForServer(server);
        try {
            await expect(
                client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`), {
                    proxyUrl: "https://tlsproxy.example.com:443",
                }),
            ).rejects.toThrow(ProxyConfigError);
            await expect(
                client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`), {
                    proxyUrl: "https://tlsproxy.example.com:443",
                }),
            ).rejects.toThrow(/https/);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("rejects unparseable proxy URLs with a typed error", async () => {
        const server = await startTestServer({ "/x": () => undefined });
        const client = clientForServer(server);
        try {
            await expect(
                client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`), {
                    proxyUrl: "not-a-proxy-url",
                }),
            ).rejects.toThrow(ProxyConfigError);
        } finally {
            await client.close();
            await server.close();
        }
    });
});

describe("BrowsersmithHttpClient — ignoreTlsErrors", () => {
    let server: TestServer;

    const handlers = {
        "/x": (_req: unknown, res: import("node:http").ServerResponse) => {
            res.writeHead(200);
            res.end("ok");
        },
    };

    it("rejects per-request ignoreTlsErrors with the typed error", async () => {
        server = await startTestServer(handlers);
        const client = clientForServer(server);
        try {
            await expect(
                client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`), {
                    ignoreTlsErrors: true,
                }),
            ).rejects.toThrow(IgnoreTlsErrorsUnsupportedError);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("rejects session proxyInfo.ignoreTlsErrors (MITM proxy sessions) the same way", async () => {
        server = await startTestServer(handlers);
        const client = clientForServer(server);
        const session = {
            proxyInfo: { ignoreTlsErrors: true },
        } as unknown as ISession;
        try {
            await expect(
                client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`), { session }),
            ).rejects.toThrow(IgnoreTlsErrorsUnsupportedError);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("rejects the flag at construction time", () => {
        expect(() => new BrowsersmithHttpClient({ ignoreTlsErrors: true })).toThrow(
            IgnoreTlsErrorsUnsupportedError,
        );
    });
});

describe("BrowsersmithHttpClient — fingerprint → profile", () => {
    it("default requests carry the chrome-140 profile's browser headers", async () => {
        const server = await startTestServer({
            "/who": (req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(String(req.headers["user-agent"] ?? ""));
            },
        });
        const client = clientForServer(server);
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/who`),
            );
            expect(await response.text()).toContain("Chrome/140");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("a firefox session fingerprint switches the wire profile to firefox-128", async () => {
        const server = await startTestServer({
            "/who": (req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(String(req.headers["user-agent"] ?? ""));
            },
        });
        const client = clientForServer(server);
        const session = { fingerprint: { browser: "firefox" } } as unknown as ISession;
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/who`),
                { session },
            );
            expect(await response.text()).toContain("Firefox/128");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("an explicitly pinned profile wins over the session fingerprint", async () => {
        const server = await startTestServer({
            "/who": (req, res) => {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(String(req.headers["user-agent"] ?? ""));
            },
        });
        const client = clientForServer(server, { profile: PROFILES["chrome-140"] });
        const session = { fingerprint: { browser: "firefox" } } as unknown as ISession;
        try {
            const response = await client.sendRequest(
                new Request(`http://127.0.0.1:${server.port}/who`),
                { session },
            );
            expect(await response.text()).toContain("Chrome/140");
        } finally {
            await client.close();
            await server.close();
        }
    });
});

describe("BrowsersmithHttpClient — construction and lifecycle", () => {
    it("rejects unknown profile ids at construction", () => {
        expect(() => new BrowsersmithHttpClient({ profile: "netscape-4" as never })).toThrow(
            UnknownProfileError,
        );
    });

    it("accepts a logger and constructs without a transport factory (real dial mode)", async () => {
        // No transportFactory: the underlying client is built for the real
        // TCP+TLS path. Constructing and closing exercises that mode without
        // touching the network.
        const logger = { warning: () => undefined, warningOnce: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined };
        const client = new BrowsersmithHttpClient({ logger: logger as never });
        await expect(client.close()).resolves.toBeUndefined();
    });

    it("accepts an explicit platform composition root", async () => {
        const server = await startTestServer({
            "/x": (_req, res) => {
                res.writeHead(200);
                res.end("ok");
            },
        });
        const { factory } = recordingTransportFactory(server);
        const { platform } = await import("browsersmith");
        const client = new BrowsersmithHttpClient({ platform, transportFactory: factory });
        try {
            const response = await client.sendRequest(new Request(`http://127.0.0.1:${server.port}/x`));
            expect(response.status).toBe(200);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("close() resolves and is safe to await once", async () => {
        const server = await startTestServer({ "/x": () => undefined });
        const client = clientForServer(server);
        await expect(client.close()).resolves.toBeUndefined();
        await server.close();
    });
});

describe("BrowsersmithHttpClient — method validation", () => {
    it("rejects methods outside browsersmith's modeled set with a typed error", async () => {
        const server = await startTestServer({ "/x": () => undefined });
        const client = new ExposedFetchClient({ transportFactory: recordingTransportFactory(server).factory });
        try {
            await expect(
                client.rawFetch(new Request(`http://127.0.0.1:${server.port}/x`, { method: "PROPFIND" })),
            ).rejects.toThrow(UnsupportedHttpMethodError);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("accepts every modeled method token case-insensitively", async () => {
        const server = await startTestServer({
            "/x": (_req, res) => {
                res.writeHead(200);
                res.end("ok");
            },
        });
        const client = new ExposedFetchClient({ transportFactory: recordingTransportFactory(server).factory });
        try {
            for (const method of ["get", "post", "head", "options"] as const) {
                const response = await client.rawFetch(
                    new Request(`http://127.0.0.1:${server.port}/x`, { method }),
                );
                expect(response.status).toBe(200);
            }
        } finally {
            await client.close();
            await server.close();
        }
    });
});

describe("BrowsersmithHttpClient — timeouts and aborts", () => {
    it("applies the constructor timeoutMs when no signal is supplied", async () => {
        const server = await startTestServer({
            "/hang": () => {
                // Never respond — the wall-clock timer must fire.
            },
        });
        const client = clientForServer(server, { timeoutMs: 150 });
        try {
            await expect(
                client.sendRequest(new Request(`http://127.0.0.1:${server.port}/hang`)),
            ).rejects.toThrow(FetchTimeoutError);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("the caller's signal owns the deadline in signal mode", async () => {
        const server = await startTestServer({
            "/hang": () => {
                // Never respond — the abort signal must cut it off.
            },
        });
        const client = clientForServer(server);
        try {
            const error = await client
                .sendRequest(new Request(`http://127.0.0.1:${server.port}/hang`), {
                    signal: AbortSignal.timeout(150),
                })
                .catch((e: unknown) => e);
            expect(error instanceof FetchError).toBe(true);
            expect((error as FetchError).kind).toBe("AbortError");
        } finally {
            await client.close();
            await server.close();
        }
    });
});

