/**
 * Conformance: cookie interchange — BrowsersmithHttpClient vs crawlee's stock
 * FetchHttpClient (undici), on the same fixtures.
 *
 * Both directions of the BaseHttpClient cookie contract, in crawlee's own
 * terms (scenario origins, Apache-2.0, apify/crawlee):
 * - request direction: the session jar's cookies ride the `cookie` header
 *   ("BaseHttpClient cookie handling": jar-only, header/jar merge with header
 *   precedence, empty jar preserves the header);
 * - response direction: every wire `Set-Cookie` lands in the jar through the
 *   `headers.getSetCookie()` harvest path (`#setCookies`) — including MULTI
 *   cookie responses, where a last-wins record would silently drop cookies;
 * - redirect interplay: "sends cookies updated by a same-origin redirect" —
 *   a Set-Cookie on the redirect hop updates the jar before the next hop.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookieJar } from "tough-cookie";
import { CLIENT_KINDS, clientFor, originOf, readJsonBody, startConformanceServer } from "./support.js";
import type { ClientKind } from "./support.js";
import type { TestServer } from "../helpers.js";

let server: TestServer;

beforeAll(async () => {
    server = await startConformanceServer();
});

afterAll(async () => {
    await server.close();
});

describe.for(CLIENT_KINDS)("cookie interchange (%s)", (kind) => {
    it("sends the jar's cookies on the request", async () => {
        const jar = new CookieJar();
        await jar.setCookie("jar_only=value", `${originOf(server)}/echo`);
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(new Request(`${originOf(server)}/echo`), {
                cookieJar: jar as unknown as import("@crawlee/types").CookieJar,
            });
            const echo = await readJsonBody(response);
            expect(echo.headers.cookie).toBe("jar_only=value");
        } finally {
            await handle.close();
        }
    });

    it("lands every cookie of a multi Set-Cookie response in the jar (getSetCookie path)", async () => {
        const jar = new CookieJar();
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(new Request(`${originOf(server)}/set-cookie`), {
                cookieJar: jar as unknown as import("@crawlee/types").CookieJar,
            });
            expect(response.headers.getSetCookie()).toHaveLength(3);
            expect(await response.text()).toBe("cookies set");
        } finally {
            await handle.close();
        }
        // The jar (not just the response view) must hold all three cookies —
        // a last-wins record would collapse them to one.
        const sent = await jar.getCookieString(`${originOf(server)}/echo`);
        expect(sent).toContain("first=1");
        expect(sent).toContain("second=2");
        expect(sent).toContain("third=3");
    });

    // Scenario mirrors "merges jar cookies with existing Cookie header":
    // explicit header cookies win over same-named jar cookies, and both sets
    // ride the request.
    it("merges header and jar cookies with header precedence", async () => {
        const jar = new CookieJar();
        await jar.setCookie("jar_cookie=from_jar", `${originOf(server)}/echo`);
        await jar.setCookie("shared=from_jar", `${originOf(server)}/echo`);
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(
                new Request(`${originOf(server)}/echo`, {
                    headers: { cookie: "shared=from_header; header_only=explicit" },
                }),
                { cookieJar: jar as unknown as import("@crawlee/types").CookieJar },
            );
            const echo = await readJsonBody(response);
            expect(echo.headers.cookie).toContain("header_only=explicit");
            expect(echo.headers.cookie).toContain("jar_cookie=from_jar");
            expect(echo.headers.cookie).toContain("shared=from_header");
            expect(echo.headers.cookie).not.toContain("shared=from_jar");
        } finally {
            await handle.close();
        }
    });

    // Scenario mirrors "sends cookies updated by a same-origin redirect": the
    // Set-Cookie on the 3xx hop is harvested before the next hop dispatches,
    // so the final hop carries the UPDATED cookie, not the stale one.
    it("applies cookies set by a redirect hop to the following hop", async () => {
        const jar = new CookieJar();
        await jar.setCookie("session=old", `${originOf(server)}/echo`);
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(
                new Request(`${originOf(server)}/redirect-set-cookie`),
                { cookieJar: jar as unknown as import("@crawlee/types").CookieJar },
            );
            const echo = await readJsonBody(response);
            expect(echo.headers.cookie).toContain("session=new");
            expect(echo.headers.cookie).not.toContain("session=old");
        } finally {
            await handle.close();
        }
    });
});

describe("cookie interchange — cross-client equivalence", () => {
    it("both clients leave identical jar contents after the same multi-cookie response", async () => {
        const jars: Record<ClientKind, string> = {
            browsersmith: "",
            undici: "",
        };
        for (const kind of CLIENT_KINDS) {
            const jar = new CookieJar();
            const handle = clientFor(kind, server);
            try {
                await handle.client.sendRequest(new Request(`${originOf(server)}/set-cookie`), {
                    cookieJar: jar as unknown as import("@crawlee/types").CookieJar,
                });
            } finally {
                await handle.close();
            }
            jars[kind] = await jar.getCookieString(`${originOf(server)}/echo`);
        }
        expect(jars.browsersmith).toBe(jars.undici);
        expect(jars.undici).toContain("first=1");
        expect(jars.undici).toContain("second=2");
        expect(jars.undici).toContain("third=3");
    });
});
