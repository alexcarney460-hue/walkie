"use strict";
const { invoke } = window.__TAURI__.core;
const distro = document.getElementById("distro");
const state = document.getElementById("state");
const open = document.getElementById("open");

async function refresh() {
  open.disabled = true;
  state.textContent = "Checking WSL and the Sqwakie daemon…";
  try {
    const result = await invoke("status");
    distro.replaceChildren(new Option("WSL default distro", ""),
      ...result.distros.map((name) => new Option(name, name)));
    distro.value = result.distro || "";
    open.disabled = !result.connected;
    state.textContent = result.connected
      ? `Connected to Sqwakie ${result.version}. Dashboard is ready.`
      : result.error || "Sqwakie is unavailable in WSL.";
    if (result.connected && !new URLSearchParams(location.search).has("settings")) {
      await invoke("show_dashboard");
    }
  } catch (error) {
    state.textContent = String(error);
  }
}

distro.addEventListener("change", async () => {
  try {
    await invoke("set_distro", { distro: distro.value || null });
    await refresh();
  } catch (error) {
    state.textContent = String(error);
  }
});
document.getElementById("retry").addEventListener("click", refresh);
open.addEventListener("click", async () => {
  open.disabled = true;
  state.textContent = "Opening your dashboard…";
  try { await invoke("show_dashboard"); }
  catch (error) { state.textContent = String(error); open.disabled = false; }
});
refresh();
