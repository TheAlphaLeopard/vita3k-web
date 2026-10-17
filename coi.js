// Registers coi_sw.js when the page lacks cross-origin isolation (a static
// host), then reloads once so the worker serves the page with its headers.
// One reload per tab session: a browser that still refuses isolation keeps
// the single-threaded build rather than looping.
(() => {
  const flag = 'vita3k-coi-reloaded';
  let reloaded = null;
  try { reloaded = sessionStorage.getItem(flag); } catch {}
  if (self.crossOriginIsolated) { try { sessionStorage.removeItem(flag); } catch {} return; }
  if (!window.isSecureContext || !navigator.serviceWorker || reloaded) return;
  const reload = () => { try { sessionStorage.setItem(flag, '1'); } catch {} location.reload(); };
  navigator.serviceWorker.register('./coi_sw.js').then(() => {
    if (navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  }, (error) => console.warn('cross-origin isolation service worker:', error));
})();
