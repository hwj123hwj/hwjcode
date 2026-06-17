#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Reserve stdout for the ACP JSON-RPC protocol BEFORE importing the rest of the
// graph. Some modules (e.g. core's proxyAuth singleton) log at import time; this
// side-effect import repoints the console to stderr first when `--acp` is set.
import './src/utils/acpStdoutGuard.js';
import './src/gemini.js';
import { main } from './src/gemini.js';
// --- Global Entry Point ---
main().catch((error) => {
    console.error('An unexpected critical error occurred:');
    if (error instanceof Error) {
        console.error(error.stack);
    }
    else {
        console.error(String(error));
    }
    process.exit(1);
});
//# sourceMappingURL=index.js.map