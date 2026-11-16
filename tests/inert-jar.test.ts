/**
 * InertCookieJar — the deliberate "Crawlee owns cookies" configuration of
 * browsersmith's jar slot. Inert on both sides; cookie fidelity is
 * header-based end to end (request cookies arrive via the header from
 * Crawlee's session, response cookies flow back through the wrapped
 * Response's getSetCookie()).
 */

import { describe, expect, it } from "vitest";
import { InertCookieJar } from "../src/client.js";

const URL_PARTS = { hostname: "example.com", pathname: "/", protocol: "https:" };

describe("InertCookieJar", () => {
    it("never yields cookies on the request side", () => {
        const jar = new InertCookieJar();
        jar.setCookie("a=1; Path=/", URL_PARTS);
        expect(jar.getCookies(URL_PARTS)).toEqual([]);
    });

    it("setCookie, removeCookie, clear, and deserialize all store nothing", () => {
        const jar = new InertCookieJar();
        jar.setCookie("a=1", URL_PARTS);
        jar.removeCookie("a", "example.com", "/");
        jar.deserialize('{"cookies": []}');
        jar.clear();
        expect(jar.getCookies(URL_PARTS)).toEqual([]);
    });

    it("serializes to an empty state", () => {
        const jar = new InertCookieJar();
        jar.setCookie("a=1", URL_PARTS);
        expect(jar.serialize()).toBe("{}");
    });

    it("exposes the jar id the browsersmith contract requires", () => {
        expect(typeof new InertCookieJar().id).toBe("string");
    });
});
