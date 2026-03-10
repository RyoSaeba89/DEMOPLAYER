/* coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
/* Adapted for DEMOPLAYER — injects COOP/COEP headers to enable SharedArrayBuffer (required by V2M WASM engine) */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

function isPassthrough(request) {
  const url = new URL(request.url);
  // Do not intercept cross-origin requests
  if (url.origin !== self.location.origin) return true;
  return false;
}

self.addEventListener("fetch", function (event) {
  if (isPassthrough(event.request)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 0) return response;

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
      .catch((e) => console.error(e))
  );
});
