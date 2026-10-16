// ============================================================================
//  coi-serviceworker.js
//  ----------------------------------------------------------------------------
//  Cross-Origin Isolation via service worker.
//
//  Injects `Cross-Origin-Opener-Policy: same-origin` and
//  `Cross-Origin-Embedder-Policy: require-corp` (plus CORP) into every
//  response served from this origin. This enables `crossOriginIsolated=true`
//  (and therefore SharedArrayBuffer + threaded WASM) on ANY static host
//  without server-side configuration:
//
//    - GitHub Pages        - Amazon S3 (static)
//    - Netlify / Vercel    - nginx (default config)
//    - python -m http.server
//    - Any static file server
//
//  Based on the coi-serviceworker pattern (MIT, (c) 2020 Guido Zuidhof).
// ============================================================================

const COI_HEADERS = {
    "Cross-Origin-Opener-Policy":   "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
};

function hasCoopCoep(headers) {
    return headers.get("Cross-Origin-Opener-Policy") === "same-origin"
        && headers.get("Cross-Origin-Embedder-Policy") === "require-corp";
}

// Take over immediately on install/activate so the very next load uses COI.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
    const req = event.request;

    // Only handle GET (don't break POSTs etc.)
    if (req.method !== "GET") return;

    // Only handle same-origin / cors requests we can actually modify
    if (req.mode === "navigate" || req.mode === "same-origin" || req.mode === "cors") {
        event.respondWith((async () => {
            try {
                const res = await fetch(req);

                // Already cross-origin isolated — pass through unchanged
                if (hasCoopCoep(res.headers)) return res;

                // Opaque responses (no-cors) can't be modified — pass through
                if (res.type === "opaque" || res.status === 0) return res;

                // Clone and inject COI headers
                const newHeaders = new Headers(res.headers);
                for (const [k, v] of Object.entries(COI_HEADERS)) {
                    newHeaders.set(k, v);
                }

                return new Response(res.body, {
                    status: res.status,
                    statusText: res.statusText,
                    headers: newHeaders,
                });
            } catch (e) {
                // Let the browser handle network errors
                return Response.error();
            }
        })());
    }
});
