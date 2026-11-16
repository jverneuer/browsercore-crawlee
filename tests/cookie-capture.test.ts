/**
 * SetCookieCaptureJar — the inert response-side capture jar.
 */

import { describe, expect, it } from "vitest";
import { SetCookieCaptureJar } from "../src/cookie-capture.js";

const URL_PARTS = { hostname: "example.com", pathname: "/", protocol: "https:" };

describe("SetCookieCaptureJar", () => {
    it("records raw Set-Cookie values in wire order, verbatim", () => {
        const jar = new SetCookieCaptureJar();
        jar.setCookie("a=1; Path=/", URL_PARTS);
        jar.setCookie("b=2; Path=/; Secure", URL_PARTS);
        expect(jar.capturedSetCookies).toEqual(["a=1; Path=/", "b=2; Path=/; Secure"]);
    });

    it("is inert on the request side — getCookies never yields cookies", () => {
        const jar = new SetCookieCaptureJar();
        jar.setCookie("a=1; Path=/", URL_PARTS);
        expect(jar.getCookies(URL_PARTS)).toEqual([]);
    });

    it("clears captures without losing identity", () => {
        const jar = new SetCookieCaptureJar();
        jar.setCookie("a=1", URL_PARTS);
        jar.clear();
        expect(jar.capturedSetCookies).toEqual([]);
        jar.setCookie("b=2", URL_PARTS);
        expect(jar.capturedSetCookies).toEqual(["b=2"]);
    });

    it("removeCookie and deserialize are no-ops", () => {
        const jar = new SetCookieCaptureJar();
        jar.setCookie("a=1", URL_PARTS);
        jar.removeCookie("a", "example.com", "/");
        expect(jar.capturedSetCookies).toEqual(["a=1"]);
        jar.deserialize('{"captured": ["c=3"]}');
        expect(jar.capturedSetCookies).toEqual(["a=1"]);
    });

    it("serializes captures to JSON", () => {
        const jar = new SetCookieCaptureJar();
        jar.setCookie("a=1", URL_PARTS);
        expect(JSON.parse(jar.serialize())).toEqual({ captured: ["a=1"] });
    });

    it("exposes the jar id the browsersmith contract requires", () => {
        const jar = new SetCookieCaptureJar();
        expect(typeof jar.id).toBe("string");
        expect(jar.id.length).toBeGreaterThan(0);
    });
});
