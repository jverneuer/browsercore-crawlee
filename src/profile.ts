/**
 * Fingerprint → browsersmith profile resolution.
 *
 * Mirrors ImpitHttpClient's `#resolveImpitBrowser` strategy, mapped onto the
 * browsersmith registry: the session's `fingerprint.browser` family selects
 * a concrete profile; the Chromium-based families the stack does not model
 * (`edge`) and unknown hints collapse onto the Chrome profile — the same
 * fallback impit applies to families it cannot model. `safari` maps to its
 * native profile (the registry models it, and its HTTP/2 framing is
 * live-validated against real edges). An explicit client-level profile wins
 * over every per-request hint — the same override precedence impit applies
 * to its `browser` option.
 */

import { getProfile, PROFILES } from "browsersmith";
import type { ProfileId } from "@browsercore/profiles";
import type { SessionFingerprint } from "@crawlee/types";
import type { ProfileSelection } from "./types.js";

/**
 * Cast a registry-guaranteed id to the branded ProfileId — the same pattern
 * browsersmith's own profiles.ts uses for its starter ids; the registry is
 * the source of truth these literals are checked against at module load.
 */
function brandedProfile(id: "safari-18"): ProfileId {
    return id as ProfileId;
}

/**
 * Resolve the browsersmith profile for one request.
 *
 * @param selection - The client-level selection: a pinned profile id or
 *   `"auto"`.
 * @param fingerprint - The per-request browser hint from the session, when
 *   the session carries one.
 * @returns The concrete profile id for the request.
 */
export function resolveProfileId(
    selection: ProfileSelection,
    fingerprint: SessionFingerprint | undefined,
): ProfileId {
    if (selection !== "auto") {
        return selection;
    }
    const family = fingerprint?.browser;
    if (family === "firefox") {
        return PROFILES["firefox-128"];
    }
    if (family === "safari") {
        // Fail fast at module load if a registry bump ever drops it.
        return getProfile(brandedProfile("safari-18")).id;
    }
    // `chrome`, Chromium-based `edge`, and fingerprint-less requests.
    return PROFILES["chrome-140"];
}
