/**
 * Fingerprint → profile resolution — pure mapping, impit-collapse semantics.
 */

import { describe, expect, it } from "vitest";
import { getProfile, PROFILES } from "browsersmith";
import { resolveProfileId } from "../src/profile.js";
import type { SessionFingerprint } from "@crawlee/types";

describe("resolveProfileId", () => {
    it("maps the chrome family to chrome-140", () => {
        const chrome: SessionFingerprint = { browser: "chrome" };
        const edge: SessionFingerprint = { browser: "edge" };
        const safari: SessionFingerprint = { browser: "safari" };
        expect(resolveProfileId("auto", chrome)).toBe(PROFILES["chrome-140"]);
        // Chromium-based families collapse onto Chrome, like impit's fallback.
        expect(resolveProfileId("auto", edge)).toBe(PROFILES["chrome-140"]);
        expect(resolveProfileId("auto", safari)).toBe(PROFILES["chrome-140"]);
    });

    it("maps the firefox family to firefox-128", () => {
        const firefox: SessionFingerprint = { browser: "firefox" };
        expect(resolveProfileId("auto", firefox)).toBe(PROFILES["firefox-128"]);
    });

    it("defaults to chrome-140 when the session carries no fingerprint", () => {
        expect(resolveProfileId("auto", undefined)).toBe(PROFILES["chrome-140"]);
        const browserless: SessionFingerprint = { platform: "windows" };
        expect(resolveProfileId("auto", browserless)).toBe(PROFILES["chrome-140"]);
    });

    it("lets an explicit profile win over the session fingerprint", () => {
        const firefox: SessionFingerprint = { browser: "firefox" };
        expect(resolveProfileId(PROFILES["chrome-140"], firefox)).toBe(PROFILES["chrome-140"]);
        expect(resolveProfileId(PROFILES["firefox-128"], undefined)).toBe(PROFILES["firefox-128"]);
    });
});
