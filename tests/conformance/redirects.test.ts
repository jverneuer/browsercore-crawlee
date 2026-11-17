/**
 * Conformance: redirect semantics — BrowsersmithHttpClient vs crawlee's stock
 * FetchHttpClient (undici), on the same fixtures.
 *
 * `BaseHttpClient.sendRequest` owns redirect handling (manual-mode loop,
 * 10-hop cap, 301/302-POST→GET and 303 semantics, cross-origin credential
 * stripping) — identical code for both clients. What differs is the concrete
 * `fetch` underneath; these twins prove the observable outcome (final
 * status/body/method and the per-hop request the server saw) is the same
 * through either transport.
 *
 * Scenario origins (Apache-2.0, apify/crawlee):
 * - "BaseHttpClient redirects that keep the request body"
 *   (test/core/base-http-client.test.ts): 307/308 keep method+body for POST,
 *   and 301/302 keep method+body for non-POST methods.
 * - `#buildRedirectRequest` semantics (packages/http-client/src/base-http-client.ts):
 *   303 always → GET with the body dropped; 301/302 on POST → GET with the
 *   body dropped; credentials (authorization, proxy-authorization, cookie)
 *   stripped on cross-origin hops, kept on same-origin hops.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_KINDS, clientFor, originOf, readJsonBody, startConformanceServer } from "./support.js";
import type { ClientKind, EchoBody } from "./support.js";
import type { TestServer } from "../helpers.js";

let server: TestServer;
/** A second physical server addressed as `localhost` — a genuinely different origin. */
let target: TestServer;

beforeAll(async () => {
    server = await startConformanceServer();
    target = await startConformanceServer();
});

afterAll(async () => {
    await server.close();
    await target.close();
});

/** Run one redirected sendRequest and echo the FINAL hop back. */
async function redirectedEcho(
    kind: ClientKind,
    request: Request,
): Promise<{ status: number; echo: EchoBody }> {
    const handle = clientFor(kind);
    try {
        const response = await handle.client.sendRequest(request);
        return { status: response.status, echo: await readJsonBody(response) };
    } finally {
        await handle.close();
    }
}

describe.for(CLIENT_KINDS)("redirect semantics (%s)", (kind) => {
    // Scenario mirrors @crawlee/http-client's "redirects that keep the request
    // body": 307/308 on POST, and 301/302 on non-POST methods, replay the
    // method and body verbatim.
    it.each([
        [307, "POST"],
        [308, "POST"],
        [301, "PUT"],
        [302, "PATCH"],
    ] as const)("keeps method and body through a %i redirect of a %s request", async (status, method) => {
        const { status: finalStatus, echo } = await redirectedEcho(
            kind,
            new Request(`${originOf(server)}/redirect?status=${status}&to=/echo`, {
                method,
                body: "hello",
            }),
        );
        expect(finalStatus).toBe(200);
        expect(echo.method).toBe(method);
        expect(echo.body).toBe("hello");
    });

    // Scenario mirrors #buildRedirectRequest: 303 ALWAYS downgrades to GET
    // and drops the body — even for methods that would otherwise replay it.
    it.each([303] as const)("303 turns a POST into a bodyless GET", async (status) => {
        const { echo } = await redirectedEcho(
            kind,
            new Request(`${originOf(server)}/redirect?status=${status}&to=/echo`, {
                method: "POST",
                body: "dropped-payload",
            }),
        );
        expect(echo.method).toBe("GET");
        expect(echo.body).toBe("");
    });

    // Same downgrade applies to 301/302 specifically for POST (fetch-era
    // semantics the base class implements for crawlers).
    it.each([301, 302] as const)("%i on a POST downgrades to a bodyless GET", async (status) => {
        const { echo } = await redirectedEcho(
            kind,
            new Request(`${originOf(server)}/redirect?status=${status}&to=/echo`, {
                method: "POST",
                body: "dropped-payload",
            }),
        );
        expect(echo.method).toBe("GET");
        expect(echo.body).toBe("");
    });

    // Scenario mirrors "does not forward credential headers to a different
    // origin": the 127.0.0.1 → localhost hop crosses origins, so
    // authorization / proxy-authorization / cookie must NOT reach the target.
    it("strips credential headers on a cross-origin redirect hop", async () => {
        const crossOriginTarget = `${originOf(target, "localhost")}/echo`;
        const { echo } = await redirectedEcho(
            kind,
            new Request(`${originOf(server)}/redirect?status=302&to=${encodeURIComponent(crossOriginTarget)}`, {
                headers: {
                    authorization: "Bearer secret",
                    "proxy-authorization": "Basic secret",
                    cookie: "token=secret",
                },
            }),
        );
        expect(echo.headers["authorization"]).toBeUndefined();
        expect(echo.headers["proxy-authorization"]).toBeUndefined();
        expect(echo.headers["cookie"]).toBeUndefined();
    });

    // Scenario mirrors "keeps credential headers on a same-origin redirect".
    it("keeps credential headers on a same-origin redirect hop", async () => {
        const { echo } = await redirectedEcho(
            kind,
            new Request(`${originOf(server)}/redirect?status=302&to=/echo`, {
                headers: {
                    authorization: "Bearer kept",
                    cookie: "token=kept",
                },
            }),
        );
        expect(echo.headers["authorization"]).toBe("Bearer kept");
        expect(echo.headers["cookie"]).toBe("token=kept");
    });

    it("follows a multi-hop redirect chain to the final hop", async () => {
        const chain =
            `${originOf(server)}/redirect?status=301&to=` +
            encodeURIComponent(`${originOf(server)}/redirect?status=302&to=/echo`);
        const requestsBefore = server.seenRequests.length;
        const { status, echo } = await redirectedEcho(kind, new Request(chain));
        expect(status).toBe(200);
        expect(echo.url).toBe("/echo");
        // Exactly three hops hit the fixture: the 301, the 302, then the echo.
        expect(server.seenRequests.length - requestsBefore).toBe(3);
    });
});

// The twins' equivalence assertion: same fixture, both clients, identical
// SEMANTIC observables. Header profiles intentionally differ — browsersmith
// sends the chrome-140 header set, undici sends node defaults; that
// difference is the anti-blocking property, asserted by the fingerprint
// parity suite, not erased here.
describe("redirect semantics — cross-client equivalence", () => {
    it("both clients land on the same final method, body, and url for a 307 POST", async () => {
        const url = `${originOf(server)}/redirect?status=307&to=/echo`;
        const run = async (kind: ClientKind): Promise<{ method: string; body: string; url: string }> => {
            const { echo } = await redirectedEcho(kind, new Request(url, { method: "POST", body: "twin-payload" }));
            return { method: echo.method, body: echo.body, url: echo.url };
        };
        expect(await run("browsersmith")).toEqual(await run("undici"));
    });
});
