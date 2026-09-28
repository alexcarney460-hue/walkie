// Walkie on your phone: reset (WALKIE-PWA-1). Nothing happens on page load: only a deliberate press of the button
// clears the pairing (IndexedDB), the offline copy (caches) and the service worker, so another page can't wipe a
// phone's pairing by sending it here.
const status = document.getElementById("status");
document.getElementById("reset")?.addEventListener("click", async () => {
  if (!window.confirm("Forget Walkie's pairing and saved data on this phone?")) return;
  const done = [];
  try { await new Promise((resolve) => { const r = indexedDB.deleteDatabase("walkie-mobile"); r.onsuccess = r.onerror = r.onblocked = resolve; }); done.push("pairing"); } catch { /* none */ }
  try { for (const k of await caches.keys()) if (k.startsWith("walkie-m-")) await caches.delete(k); done.push("offline copy"); } catch { /* none */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); done.push("worker"); } catch { /* none */ }
  try { localStorage.removeItem("walkie.install.dismissed"); } catch { /* none */ }
  if (status) status.textContent = `Done: cleared ${done.join(", ") || "nothing"}. Pair again from your computer to use Walkie here.`;
});
