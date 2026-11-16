/**
 * Fingerprint → browsersmith profile resolution.
 *
 * Mirrors ImpitHttpClient's `#resolveImpitBrowser` strategy exactly: the
 * session's `fingerprint.browser` family selects a concrete profile; every
 * family outside the two the stack has battle-tested (`edge`, `safari`) and
 * the fingerprint-less default collapse onto the Chrome profile so the request
 * still carries a realistic browser fingerprint. An explicit client-level
 * profile wins over every per-request hint — the same override precedence
 * impit applies to its `browser` option.
 *
 * (`safari-18`/`edge-128` exist in the registry; callers who want them pin
 * them explicitly via {@link BrowsersmithHttpClientOptions.profile}. Note
 * safari-18's HTTP/2 SETTINGS currently draw GOAWAY/PROTOCOL_ERROR from
 * common nginx deployments — see the README limitations.)
 */

import { PROFILES } from "browsersmith";
import type { ProfileId } from "@browsercore/profiles";
import type { SessionFingerprint } from "@crawlee/types";
import type { ProfileSelection } from "./types.js";

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
    // Only the two battle-tested families get their native profile; Chromium
    // families and unknown hints collapse onto Chrome — the same fallback
    // impit applies to families it cannot model.
    return fingerprint?.browser === "firefox" ? PROFILES["firefox-128"] : PROFILES["chrome-140"];
}
