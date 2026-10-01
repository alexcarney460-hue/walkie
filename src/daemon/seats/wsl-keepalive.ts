import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import type { Check } from "./doctor.ts";
import { run } from "../machine-stats/read.ts";
import { findPowershellDetail, interopRoutes, isWsl } from "../machine-stats/wsl.ts";

const WINDOWS_QUERY = [
  "$ErrorActionPreference='Stop'",
  "$p=Join-Path $env:USERPROFILE '.wslconfig'",
  "$t=if(Test-Path -LiteralPath $p){[IO.File]::ReadAllText($p)}else{''}",
  "$s=[regex]::Match($t,'(?ims)^\\s*\\[wsl2\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|\\z)')",
  "$idle=$s.Success -and [regex]::IsMatch($s.Groups[1].Value,'(?im)^\\s*vmIdleTimeout\\s*=\\s*-1\\s*(?:[#;].*)?$')",
  "$k=Get-ScheduledTask -TaskName 'WalkieWSLKeepAlive' -ErrorAction SilentlyContinue",
  "$task=$null -ne $k -and @($k.Actions | Where-Object { $_.Execute -match '(?i)wsl\\.exe$' -and $_.Arguments -ceq '-d Ubuntu -u __USER__ -- sleep infinity' }).Count -eq 1",
  "$battery=$null -ne $k -and -not $k.Settings.DisallowStartIfOnBatteries -and -not $k.Settings.StopIfGoingOnBatteries",
  "$restart=$null -ne $k -and $k.Settings.RestartCount -ge 3 -and $k.Settings.ExecutionTimeLimit -eq 'PT0S'",
  "$logon=$null -ne $k -and @($k.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -gt 0",
  "$repeat=$null -ne $k -and @($k.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT5M' }).Count -gt 0",
  "$r=Join-Path $env:LOCALAPPDATA 'WalkieEnroll\\receipts\\packages.json'",
  "$packages=if(Test-Path -LiteralPath $r){(Get-Content -LiteralPath $r -Raw|ConvertFrom-Json).packages}else{$null}",
  "@{idle=$idle;task=$task;battery=$battery;restart=$restart;logon=$logon;repeat=$repeat;packages=$packages}|ConvertTo-Json -Compress -Depth 4",
].join("; ");

export interface WslKeepaliveDeps {
  wsl?: () => Promise<boolean>;
  conf?: () => Promise<string>;
  loginctl?: () => Promise<string | null>;
  windows?: () => Promise<string | null>;
}

async function windowsStatus(): Promise<string | null> {
  const found = await findPowershellDetail();
  if (!found.bin) return null;
  const user = userInfo().username;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(user)) return null;
  const argv = [found.bin, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY.replaceAll("__USER__", user)];
  for (const route of await interopRoutes()) {
    const result = await run(argv, { ...(route.path ? { env: { WSL_INTEROP: route.path } } : {}) });
    if (result !== null) return result;
  }
  return null;
}

/** The Linux daemon can report persistence without assuming a running Windows terminal. */
export async function wslKeepaliveChecks(deps: WslKeepaliveDeps = {}): Promise<Check[]> {
  let wsl: boolean;
  try { wsl = await (deps.wsl ?? isWsl)(); }
  catch { return [{ ok: false, what: "WSL detection unavailable", fix: "check /proc and the WSL interop settings" }]; }
  if (!wsl) return [];
  const conf = await (deps.conf ?? (() => readFile("/etc/wsl.conf", "utf8")))().catch(() => "");
  const section = /(?:^|\n)\s*\[boot\]\s*\r?\n([^[]*)/i.exec(conf)?.[1] ?? "";
  const systemd = /^\s*systemd\s*=\s*true\s*$/im.test(section);
  const linger = (await (deps.loginctl ?? (() => run(["/usr/bin/loginctl", "show-user", process.env.USER ?? "", "-p", "Linger", "--value"])))().catch(() => null))?.trim() === "yes";
  const raw = await (deps.windows ?? windowsStatus)().catch(() => null);
  let win: Record<string, unknown> = {};
  try { win = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* report failure below */ }
  const check = (ok: boolean, what: string, fix: string): Check => ok ? { ok: true, what } : { ok: false, what, fix };
  const names = ["curl", "openssl", "ca-certificates", "python3"];
  const packages = win.packages && typeof win.packages === "object" && !Array.isArray(win.packages) ? win.packages as Record<string, unknown> : {};
  const versionsOk = Object.keys(packages).length === names.length && names.every((name) => typeof packages[name] === "string" && /^[A-Za-z0-9.+:~_-]{1,100}$/.test(packages[name] as string));
  const versionText = versionsOk ? names.map((name) => `${name}=${packages[name]}`).join(", ") : "missing";
  return [
    check(systemd, "WSL systemd on", "set [boot] systemd=true in /etc/wsl.conf and restart WSL"),
    check(linger, "WSL user linger on", "loginctl enable-linger for this Ubuntu user"),
    check(win.idle === true, "Windows WSL VM idle timeout disabled", "set [wsl2] vmIdleTimeout=-1 in .wslconfig"),
    check(win.task === true && win.battery === true && win.restart === true && win.logon === true && win.repeat === true,
      "Windows logon keep-alive task configured", "repair WalkieWSLKeepAlive in Windows Task Scheduler"),
    check(versionsOk, `Ubuntu package versions: ${versionText}`, "complete signed Windows enrollment to record Ubuntu package versions"),
  ];
}
