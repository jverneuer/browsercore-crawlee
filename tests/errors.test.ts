/**
 * Typed-error hierarchy — every failure mode is an explicit class matched on
 * `kind` per the house error pattern.
 */

import { describe, expect, it } from "vitest";
import {
    BrowsersmithHttpClientError,
    IgnoreTlsErrorsUnsupportedError,
    UnsupportedHttpMethodError,
} from "../src/index.js";

describe("typed error hierarchy", () => {
    it("routes every client error through the base class", () => {
        const ignore = new IgnoreTlsErrorsUnsupportedError({ source: "constructor" });
        const method = new UnsupportedHttpMethodError("TRACE");
        expect(ignore instanceof BrowsersmithHttpClientError).toBe(true);
        expect(method instanceof BrowsersmithHttpClientError).toBe(true);
        expect(ignore instanceof Error).toBe(true);
    });

    it("carries kind, details, and name per subclass", () => {
        const ignore = new IgnoreTlsErrorsUnsupportedError({ source: "request" });
        expect(ignore.kind).toBe("IgnoreTlsErrorsUnsupportedError");
        expect(ignore.name).toBe("IgnoreTlsErrorsUnsupportedError");
        expect(ignore.details).toEqual({ source: "request" });
        expect(ignore.message).toContain("ignoreTlsErrors");
        expect(ignore.message).toContain("certificate");

        const method = new UnsupportedHttpMethodError("PROPFIND");
        expect(method.kind).toBe("UnsupportedHttpMethodError");
        expect(method.method).toBe("PROPFIND");
        expect(method.message).toContain("PROPFIND");
        expect(method.message).toContain("GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
    });

    it("preserves cause through the base class", () => {
        const cause = new Error("underlying");
        const base = new BrowsersmithHttpClientError("wrapped", { a: 1 }, { cause });
        expect(base.kind).toBe("BrowsersmithHttpClientError");
        expect(base.details).toEqual({ a: 1 });
        expect(base.cause).toBe(cause);
        expect(base.name).toBe("BrowsersmithHttpClientError");
    });
});
