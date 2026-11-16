import { definePackageConfig } from "@browsercore/dev/vitest";

export default definePackageConfig({
    name: "@browsercore/crawlee",
    coverage: {
        // CI's own gate reads coverage-summary.json at >=93%; this package holds
        // itself to the 90% floor required for integration packages (the
        // live-network test file contributes no additional source).
        thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
});
