import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isFcronConfigTree, realAdminSys, removeSeatSchedules } from "../../src/daemon/seats/admin-sys.ts";
import { schedulerProblem, SCHEDULER_FILES } from "../../src/daemon/seats/seat-user.ts";
import { createSeatUser } from "../../src/daemon/seats/admin.ts";
import { createTalkieUser } from "../../src/daemon/seats/talkie-user.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const temps: string[] = [];
const realOpen = fs.openSync;
let guard: ReturnType<typeof spyOn>;
beforeEach(() => {
  guard = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (/^\/(etc|var\/spool|usr\/lib\/cron)(\/|$)/.test(String(path))) throw new Error("fixture refused live scheduler path");
    return (realOpen as Function)(path, ...args);
  }) as typeof fs.openSync);
});
afterEach(() => { guard.mockRestore(); for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/walkie-scheduler-hardening-"));
  temps.push(root);
  const at = (p: string) => join(root, p);
  const put = (p: string, text = "keep\n") => {
    mkdirSync(dirname(at(p)), { recursive: true }); writeFileSync(at(p), text, { mode: 0o600 });
  };
  return { root, at, put, sys: realAdminSys({ platform: "linux", spoolRoot: root }) };
}

const benignLayouts = [
  { name: "mail directory link", add: (f: ReturnType<typeof fixture>) => { f.put("/var/mail/notice"); mkdirSync(f.at("/var/spool"), { recursive: true }); symlinkSync("../mail", f.at("/var/spool/mail")); }, evidence: "/var/mail/fcron-worker" },
  { name: "X11 directory loop", add: (f: ReturnType<typeof fixture>) => { f.put("/usr/bin/ls"); symlinkSync(".", f.at("/usr/bin/X11")); }, evidence: "/usr/bin/fcron-worker" },
  { name: "deep local tree", add: (f: ReturnType<typeof fixture>) => f.put("/usr/local/go/src/cmd/compile/internal/ssa/compile.go"), evidence: "/usr/local/go/fcron-worker" },
  { name: "deep library tree", add: (f: ReturnType<typeof fixture>) => f.put("/var/lib/docker/overlay2/id/diff/usr/bin/sh"), evidence: "/var/lib/docker/fcron-worker" },
  { name: "large configuration file", add: (f: ReturnType<typeof fixture>) => f.put("/etc/udev/hwdb.bin", "x".repeat(1024 * 1024 + 1)), evidence: "/etc/fcron-worker" },
  { name: "masked unit", add: (f: ReturnType<typeof fixture>) => { mkdirSync(f.at("/etc/systemd/system"), { recursive: true }); symlinkSync("/dev/null", f.at("/etc/systemd/system/sleep.target")); }, evidence: "/etc/fcron-worker" },
  { name: "dangling configuration link", add: (f: ReturnType<typeof fixture>) => { mkdirSync(f.at("/etc"), { recursive: true }); symlinkSync("../run/missing", f.at("/etc/resolv.conf")); }, evidence: "/etc/fcron-worker" },
  { name: "local man directory link", add: (f: ReturnType<typeof fixture>) => { f.put("/usr/local/share/man/man1/ls.1"); symlinkSync("share/man", f.at("/usr/local/man")); }, evidence: "/usr/local/share/man/fcron-worker" },
];

test("ordinary Linux layouts permit both account kinds and write the stock deny entry", () => {
  const f = fixture();
  for (const layout of benignLayouts) layout.add(f);
  f.sys.denySchedulers("walkie-s1");
  f.sys.denySchedulers("walkie-talkie");
  expect(readFileSync(f.at("/etc/fcron.deny"), "utf8")).toStartWith("walkie-talkie\nwalkie-s1\n");
});

for (const layout of benignLayouts) test(`${layout.name} does not hide adjacent fcron evidence`, () => {
  const f = fixture(); layout.add(f); f.put(layout.evidence);
  for (const name of ["walkie-s1", "walkie-talkie"])
    expect(() => f.sys.denySchedulers(name)).toThrow(/fcron/i);
  expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
});

test("a directory link outside searched trees exposes fcron evidence without cycling", () => {
  const f = fixture(); f.put("/srv/vendor/fcron-worker");
  mkdirSync(f.at("/usr/local"), { recursive: true });
  symlinkSync(f.at("/srv/vendor"), f.at("/usr/local/vendor"));
  expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/fcron/i);
});

test("a linked vendor configuration directory is scanned for fcron keys", () => {
  const f = fixture(); f.put("/srv/vendor-config/scheduler.conf", "fcrontabs = /srv/vendor-spool\n");
  mkdirSync(f.at("/opt/vendor"), { recursive: true });
  symlinkSync(f.at("/srv/vendor-config"), f.at("/opt/vendor/etc"));
  for (const name of ["walkie-s1", "walkie-talkie"])
    expect(() => f.sys.denySchedulers(name)).toThrow(/fcron/i);
  expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
});

test("isFcronConfigTree recognizes the documented trees as reached and by resolved target", () => {
  for (const p of ["/etc", "/etc/fcron.deny", "/usr/local/etc", "/usr/local/etc/vendor.conf",
    "/opt/vendor/etc", "/opt/vendor/etc/scheduler.conf"])
    expect(isFcronConfigTree(p)).toBe(true);
  for (const p of ["/", "/usr", "/usr/local", "/usr/local/share", "/usr/local/etcx", "/etcx",
    "/opt", "/opt/etc", "/opt/vendor", "/opt/vendor/bin", "/opt/vendor/bin/etc", "/opt/vendor/etcx",
    "/var/lib/legacy", "/var/spool/mail"])
    expect(isFcronConfigTree(p)).toBe(false);
  // A directory link is judged by the path as the search reached it and by its resolved target.
  expect(isFcronConfigTree("/var/lib/legacy", "/usr/local/etc")).toBe(true);
  expect(isFcronConfigTree("/var/lib/legacy", "/opt/vendor/etc")).toBe(true);
  expect(isFcronConfigTree("/var/lib/legacy", "/etc")).toBe(true);
  expect(isFcronConfigTree("/var/spool/mail", "/var/mail")).toBe(false);
  expect(isFcronConfigTree("/var/lib/legacy", "/srv/tree")).toBe(false);
});

// Every documented configuration tree against every way the search can reach it. Most link
// targets sit outside the searched roots; "link above the tree" links an ancestor inside a
// searched root (/usr/local is a search root, /opt/vendor sits inside the /opt root). The
// last rows link at the tree or inside it with the target inside the same or another
// searched root.
const configTreeReach: { tree: string; reach: string; make: (f: ReturnType<typeof fixture>, content: string) => void }[] = [
  { tree: "/etc", reach: "a real directory", make: (f, content) => { f.put("/etc/vendor-scheduler.conf", content); } },
  { tree: "/etc", reach: "a link at the tree", make: (f, content) => {
    f.put("/srv/tree/vendor-scheduler.conf", content);
    symlinkSync(f.at("/srv/tree"), f.at("/etc"));
  } },
  { tree: "/usr/local/etc", reach: "a real directory", make: (f, content) => { f.put("/usr/local/etc/vendor-scheduler.conf", content); } },
  { tree: "/usr/local/etc", reach: "a link at the tree", make: (f, content) => {
    f.put("/srv/tree/vendor-scheduler.conf", content);
    mkdirSync(f.at("/usr/local"), { recursive: true });
    symlinkSync(f.at("/srv/tree"), f.at("/usr/local/etc"));
  } },
  { tree: "/usr/local/etc", reach: "a link at the tree to a file", make: (f, content) => {
    f.put("/srv/tree/vendor-scheduler.conf", content);
    mkdirSync(f.at("/usr/local"), { recursive: true });
    symlinkSync(f.at("/srv/tree/vendor-scheduler.conf"), f.at("/usr/local/etc"));
  } },
  { tree: "/usr/local/etc", reach: "a link above the tree", make: (f, content) => {
    f.put("/srv/usrlocal/etc/vendor-scheduler.conf", content);
    mkdirSync(f.at("/usr"), { recursive: true });
    symlinkSync(f.at("/srv/usrlocal"), f.at("/usr/local"));
  } },
  { tree: "/opt/vendor/etc", reach: "a real directory", make: (f, content) => { f.put("/opt/vendor/etc/vendor-scheduler.conf", content); } },
  { tree: "/opt/vendor/etc", reach: "a link at the tree", make: (f, content) => {
    f.put("/srv/tree/vendor-scheduler.conf", content);
    mkdirSync(f.at("/opt/vendor"), { recursive: true });
    symlinkSync(f.at("/srv/tree"), f.at("/opt/vendor/etc"));
  } },
  { tree: "/opt/vendor/etc", reach: "a link at the tree to a file", make: (f, content) => {
    f.put("/srv/tree/vendor-scheduler.conf", content);
    mkdirSync(f.at("/opt/vendor"), { recursive: true });
    symlinkSync(f.at("/srv/tree/vendor-scheduler.conf"), f.at("/opt/vendor/etc"));
  } },
  { tree: "/opt/vendor/etc", reach: "a link above the tree", make: (f, content) => {
    f.put("/srv/vendor/etc/vendor-scheduler.conf", content);
    mkdirSync(f.at("/opt"), { recursive: true });
    symlinkSync(f.at("/srv/vendor"), f.at("/opt/vendor"));
  } },
  { tree: "/opt/vendor/etc", reach: "a link at the tree to a directory inside the same searched root", make: (f, content) => {
    f.put("/opt/vendor/shared/etc/vendor-scheduler.conf", content);
    mkdirSync(f.at("/opt/vendor"), { recursive: true });
    symlinkSync("shared/etc", f.at("/opt/vendor/etc"));
  } },
  { tree: "/usr/local/etc", reach: "a link at the tree to a directory inside another searched root", make: (f, content) => {
    f.put("/opt/vendor/conf/vendor-scheduler.conf", content);
    mkdirSync(f.at("/usr/local"), { recursive: true });
    symlinkSync(f.at("/opt/vendor/conf"), f.at("/usr/local/etc"));
  } },
  { tree: "/etc", reach: "a directory link inside the tree to another searched root", make: (f, content) => {
    f.put("/var/lib/vendor/conf/vendor-scheduler.conf", content);
    mkdirSync(f.at("/etc"), { recursive: true });
    symlinkSync(f.at("/var/lib/vendor/conf"), f.at("/etc/vendor.d"));
  } },
];

for (const { tree, reach, make } of configTreeReach) {
  test(`${tree} as ${reach} refuses creation on an fcron-keyed file`, () => {
    const f = fixture(); make(f, "fcrontabs = /opt/vendor/spool\n");
    for (const name of ["walkie-s1", "walkie-talkie"])
      expect(() => f.sys.denySchedulers(name)).toThrow(/fcron/i);
    expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
  });
  test(`${tree} as ${reach} without fcron keys permits creation and writes the deny entry`, () => {
    const f = fixture(); make(f, "port = 1234\nname = unrelated\n");
    for (const name of ["walkie-s1", "walkie-talkie"]) {
      expect(() => f.sys.denySchedulers(name)).not.toThrow();
      expect(readFileSync(f.at("/etc/fcron.deny"), "utf8")).toContain(`${name}\n`);
    }
  });
}

test("a directory link loop between configuration trees ends and permits creation", () => {
  const f = fixture();
  mkdirSync(f.at("/etc/tree-a"), { recursive: true });
  mkdirSync(f.at("/usr/local/etc/tree-b"), { recursive: true });
  symlinkSync(f.at("/usr/local/etc/tree-b"), f.at("/etc/tree-a/loop"));
  symlinkSync(f.at("/etc/tree-a"), f.at("/usr/local/etc/tree-b/loop"));
  expect(() => f.sys.denySchedulers("walkie-s1")).not.toThrow();
  expect(readFileSync(f.at("/etc/fcron.deny"), "utf8")).toContain("walkie-s1\n");
});

test("external directory links stop at the five-level search depth", () => {
  const f = fixture();
  f.put("/srv/d6/fcron-worker");
  mkdirSync(f.at("/usr/local"), { recursive: true });
  for (let depth = 1; depth <= 6; depth++) {
    mkdirSync(f.at(`/srv/d${depth}`), { recursive: true });
    symlinkSync(f.at(`/srv/d${depth}`), f.at(depth === 1 ? "/usr/local/vendor" : `/srv/d${depth - 1}/next`));
  }
  expect(() => f.sys.denySchedulers("walkie-s1")).not.toThrow();
  expect(readFileSync(f.at("/etc/fcron.deny"), "utf8")).toContain("walkie-s1\n");
});

test("a linked stock fcron spool still refuses when populated", () => {
  const f = fixture(); f.put("/srv/fcron-tabs/old-tab");
  mkdirSync(f.at("/var/spool"), { recursive: true });
  symlinkSync(f.at("/srv/fcron-tabs"), f.at("/var/spool/fcron"));
  expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/fcron spool is populated/);
});

test("a stock fcron spool that cannot be enumerated still refuses", () => {
  const f = fixture(); f.put("/var/spool/fcron", "not a directory\n");
  expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/cannot inspect \/var\/spool\/fcron/);
});

test("an unprotected configuration link refuses only when its target has fcron keys", () => {
  const f = fixture(); f.put("/srv/vendor/settings", "port = 1234\n");
  mkdirSync(f.at("/etc"), { recursive: true }); symlinkSync(f.at("/srv/vendor/settings"), f.at("/etc/settings"));
  expect(() => f.sys.denySchedulers("walkie-s1")).not.toThrow();
  f.put("/srv/vendor/settings", "fcrontabs = /srv/vendor/spool\n");
  expect(() => f.sys.denySchedulers("walkie-talkie")).toThrow(/fcron/i);
});

for (const talkie of [false, true]) test(`ordinary mail link permits ${talkie ? "WalkieTalkie" : "seat"} creation`, async () => {
  const f = fixture(); f.put("/var/mail/notice");
  mkdirSync(f.at("/var/spool"), { recursive: true }); symlinkSync("../mail", f.at("/var/spool/mail"));
  const w = fakeSeatWorld(f.root, f.at("walkie"));
  const sys = { ...w.sys, schedulerFiles: f.sys.schedulerFiles, readSchedulerFile: f.sys.readSchedulerFile,
    denySchedulers: f.sys.denySchedulers };
  try {
    const result = talkie ? await createTalkieUser(sys, "11111111-1111-4111-8111-111111111111", "a".repeat(64))
      : await createSeatUser(1, sys);
    expect(result.ok).toBe(true);
    expect(w.created).toContain(talkie ? "walkie-talkie" : "walkie-s1");
    expect(readFileSync(f.at("/etc/fcron.deny"), "utf8")).toContain(talkie ? "walkie-talkie" : "walkie-s1");
  } finally { w.sys.ledger().close(); }
});

test("fixture guard blocks a live scheduler open before any syscall", () => {
  expect(() => fs.openSync("/etc/cron.deny", "wx")).toThrow("fixture refused live scheduler path");
});

for (const exists of [true, false]) test(`spool-directory symlink is refused, account exists=${exists}`, () => {
  const f = fixture();
  f.put("outside/walkie-s1");
  symlinkSync(f.at("outside"), f.at("spool"));
  const why = removeSeatSchedules("walkie-s1", 600001, exists, [f.at("spool")], []);
  expect(why).toContain("symbolic link");
  expect(readFileSync(f.at("outside/walkie-s1"), "utf8")).toBe("keep\n");
});

test("a refused spool directory does not stop removal in other spools", () => {
  const f = fixture(); f.put("outside/walkie-s1"); f.put("other/walkie-s1");
  symlinkSync(f.at("outside"), f.at("spool"));
  expect(removeSeatSchedules("walkie-s1", 600001, true, [f.at("spool"), f.at("other")], [])).toContain("symbolic link");
  expect(existsSync(f.at("other/walkie-s1"))).toBe(false);
  expect(existsSync(f.at("outside/walkie-s1"))).toBe(true);
});

test("a flat-layout user named tabs does not prevent another user's retirement", () => {
  const f = fixture(); f.put("/var/spool/cron/tabs"); f.put("/var/spool/cron/walkie-s1");
  expect(f.sys.removeSchedules("walkie-s1", 600001, true)).toBeNull();
  expect(readFileSync(f.at("/var/spool/cron/tabs"), "utf8")).toBe("keep\n");
});

test("a flat-layout tabs file owned by the retiring uid is still reported", () => {
  const f = fixture(); f.put("/var/spool/cron/tabs");
  expect(f.sys.removeSchedules("walkie-s1", process.getuid!(), true)).toContain("scheduled jobs");
});

test("SUSE atjobs and symlinked at spools are checked through production wiring", () => {
  const f = fixture(); f.put("/var/spool/atjobs/a00001");
  expect(f.sys.removeSchedules("walkie-s1", process.getuid!(), true)).toContain("/var/spool/atjobs/a00001");
  const g = fixture(); g.put("outside/job"); mkdirSync(g.at("/var/spool"), { recursive: true });
  symlinkSync(g.at("outside"), g.at("/var/spool/atjobs"));
  expect(g.sys.removeSchedules("walkie-s1", 600001, true)).toContain("symbolic link");
});

test("Linux creation writes an exact fcron deny before all, preserving neighbors", () => {
  const f = fixture(); f.put("/etc/fcron.deny", "all\nwalkie-s1\nneighbor\n");
  f.put("/etc/fcron.allow", "walkie-s1\n");
  f.sys.denySchedulers("walkie-s1");
  expect(readFileSync(f.at("/etc/fcron.deny"), "utf8").split("\n")[0]).toBe("walkie-s1");
  expect(readFileSync(f.at("/etc/fcron.deny"), "utf8")).toContain("neighbor\n");
  expect(schedulerProblem(["walkie-s1"], f.sys.schedulerFiles, f.sys.readSchedulerFile)).toBeNull();
});

test("fcron uses its own precedence, including first all versus explicit deny", () => {
  const check = (allow: string | null, deny: string | null) => schedulerProblem(["walkie-s1"], SCHEDULER_FILES.linux,
    (p) => p === "/etc/fcron.allow" ? allow : p === "/etc/fcron.deny" ? deny : p.endsWith(".deny") ? "walkie-s1\n" : null);
  expect(check("walkie-s1\n", "all\nwalkie-s1\n")).toContain("fcron");
  expect(check("walkie-s1\n", "walkie-s1\nall\n")).toBeNull();
  expect(check("all\n", "  walkie-s1 \n")).toBeNull();
  expect(check(null, null)).toContain("fcron");
});

for (const [key, value] of [["fcrontabs", "/custom/spool"], ["fcronallow", "/custom/allow"], ["fcrondeny", "/custom/deny"]]) {
  test(`custom ${key} is explicitly refused before default files are changed`, () => {
    const f = fixture(); f.put("/etc/fcron.conf", `${key} = ${value}\n`);
    f.put("/var/spool/fcron/walkie-s1");
    expect(() => f.sys.denySchedulers("walkie-s1")).toThrow("unsupported fcron");
    expect(f.sys.removeSchedules("walkie-s1", 600001, true)).toContain("unsupported fcron");
    expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
    expect(existsSync(f.at("/var/spool/fcron/walkie-s1"))).toBe(true);
  });
}

test("Talkie is refused on a detected fcron host even with a deny entry and empty spool", () => {
  const f = fixture(); f.put("/etc/fcron.conf", "fcrontabs = /var/spool/fcron\n");
  f.put("/etc/fcron.deny", "walkie-talkie\n");
  expect(() => f.sys.denySchedulers("walkie-talkie")).toThrow("loaded");
});

test("alternate fcron config inside the stock spool refuses a seat before scheduler files change", () => {
  const f = fixture();
  f.put("/var/spool/fcron/vendor/etc/scheduler.conf",
    "fcrontabs = /var/spool/fcron/vendor/tabs\nfcronallow = /var/spool/fcron/vendor/allow\nfcrondeny = /var/spool/fcron/vendor/deny\n");
  expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/fcron/i);
  expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
});

test("any stock fcron spool entry refuses a seat even without configuration", () => {
  const f = fixture(); f.put("/var/spool/fcron/old-tab");
  expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/fcron/i);
  expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
});

test("alternate fcron installation refuses both account kinds before scheduler files change", () => {
  for (const path of ["/opt/vendor/etc/fcron.conf", "/usr/local/etc/fcron.conf"]) {
    const f = fixture(); f.put(path, "fcrontabs = /opt/vendor/spool\n");
    for (const name of ["walkie-s1", "walkie-talkie"]) {
      expect(() => f.sys.denySchedulers(name)).toThrow(/fcron/i);
      expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
    }
  }
});

test("markerless vendor fcron config refuses both account kinds before scheduler files change", () => {
  for (const path of ["/opt/vendor/etc/scheduler.conf", "/opt/vendor/etc/scheduler.cfg"]) {
    for (const name of ["walkie-s1", "walkie-talkie"]) {
      const f = fixture(); f.put(path,
        "fcrontabs = /opt/vendor/spool\nfcronallow = /opt/vendor/allow\nfcrondeny = /opt/vendor/deny\n");
      expect(() => f.sys.denySchedulers(name)).toThrow(/fcron/i);
      expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
    }
  }
});

test("unrelated vendor configuration does not trigger a scheduler refusal", () => {
  const f = fixture(); f.put("/opt/vendor/etc/other.conf", "port = 1234\nname = unrelated\n");
  expect(() => f.sys.denySchedulers("walkie-s1")).not.toThrow();
});

for (const target of ["/opt/vendor/bin/fcron", "/run/fcron.fifo", "/run/fcron.pid"]) {
  test(`a markerless process with ${target} open is refused`, () => {
    const f = fixture();
    const link = target.includes("/bin/") ? "/proc/321/exe" : "/proc/321/fd/3";
    mkdirSync(dirname(f.at(link)), { recursive: true });
    if (link.includes("/fd/")) symlinkSync("/opt/vendor/bin/vendor-worker", f.at("/proc/321/exe"));
    symlinkSync(target, f.at(link));
    const sys = realAdminSys({ platform: "linux", spoolRoot: f.root, processList: "321 vendor-worker --quiet\n" });
    expect(() => sys.denySchedulers("walkie-s1")).toThrow(/fcron/i);
    expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
  });
}

test("markerless vendor config symlink cannot bypass the installation search", () => {
  for (const extension of ["conf", "cfg"]) {
    const f = fixture(); f.put("/opt/vendor/private/scheduler.txt", "fcrontabs = /opt/vendor/spool\n");
    mkdirSync(f.at("/opt/vendor/etc"), { recursive: true });
    symlinkSync(f.at("/opt/vendor/private/scheduler.txt"), f.at(`/opt/vendor/etc/scheduler.${extension}`));
    expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/fcron/i);
    expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
  }
});

test("markerless /etc .cfg symlink to fcron configuration refuses both accounts", () => {
  for (const name of ["walkie-s1", "walkie-talkie"]) {
    const f = fixture();
    f.put("/opt/vendor/private/scheduler.txt", "fcrontabs = /opt/vendor/spool\nfcronallow = /opt/vendor/allow\nfcrondeny = /opt/vendor/deny\n");
    mkdirSync(f.at("/etc"), { recursive: true });
    symlinkSync(f.at("/opt/vendor/private/scheduler.txt"), f.at("/etc/scheduler.cfg"));
    expect(() => f.sys.denySchedulers(name)).toThrow(/fcron/i);
    expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
  }
});

test("protected /etc configuration symlink is examined", () => {
  const f = fixture();
  f.put("/opt/vendor/private/scheduler.txt", "fcrontabs = /opt/vendor/spool\n");
  mkdirSync(f.at("/etc"), { recursive: true });
  symlinkSync(f.at("/opt/vendor/private/scheduler.txt"), f.at("/etc/scheduler.cfg"));
  const realLstat = fs.lstatSync;
  const ownership = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    const st = (realLstat as Function)(path, ...args) as fs.Stats;
    return path === f.at("/etc") || path === f.at("/etc/scheduler.cfg")
      ? Object.assign(Object.create(st), { uid: 0 }) as fs.Stats : st;
  }) as typeof fs.lstatSync);
  try { expect(() => f.sys.denySchedulers("walkie-s1")).toThrow(/fcron/i); }
  finally { ownership.mockRestore(); }
});

test("markerless process holding /run/fcron/fifo refuses a seat account", () => {
  const f = fixture();
  mkdirSync(f.at("/proc/321/fd"), { recursive: true });
  symlinkSync("/opt/vendor/bin/vendor-worker", f.at("/proc/321/exe"));
  symlinkSync("/run/fcron/fifo", f.at("/proc/321/fd/3"));
  const sys = realAdminSys({ platform: "linux", spoolRoot: f.root, processList: "321 vendor-worker --quiet\n" });
  expect(() => sys.denySchedulers("walkie-s1")).toThrow(/fcron/i);
  expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
});

test("an open fcron FIFO is checked when a process has no exe link", () => {
  const f = fixture();
  mkdirSync(f.at("/proc/321/fd"), { recursive: true });
  symlinkSync("/run/fcron/fifo", f.at("/proc/321/fd/3"));
  const sys = realAdminSys({ platform: "linux", spoolRoot: f.root, processList: "321 vendor-worker --quiet\n" });
  for (const name of ["walkie-s1", "walkie-talkie"]) {
    expect(() => sys.denySchedulers(name)).toThrow(/fcron/i);
    expect(existsSync(f.at("/etc/fcron.deny"))).toBe(false);
  }
});

test("a scheduler refusal releases Talkie's claim so a fixed host can retry", async () => {
  const f = fixture(); const w = fakeSeatWorld(f.root, f.at("walkie"));
  const deny = w.sys.denySchedulers;
  w.sys.denySchedulers = () => { throw new Error("unsupported fcron configuration"); };
  try {
    const run = "11111111-1111-4111-8111-111111111111";
    const instance = "a".repeat(64);
    const first = await createTalkieUser(w.sys, run, instance);
    expect(first.ok).toBe(false);
    w.sys.denySchedulers = deny;
    const second = await createTalkieUser(w.sys, run, instance);
    expect(second.ok).toBe(true);
  } finally { w.sys.ledger().close(); }
});

for (const config of ["fcront = /other\n", "fcrontabs /other\n", "#" + " ".repeat(1023) + "fcrontabs=/other\n", "#\0ignored\n"]) {
  test(`ambiguous fcron config is refused (${JSON.stringify(config.slice(0, 24))})`, () => {
    const f = fixture(); f.put("/etc/fcron.conf", config);
    expect(() => f.sys.denySchedulers("walkie-s1")).toThrow("unsupported fcron");
    expect(f.sys.removeSchedules("walkie-s1", 600001, true)).toContain("unsupported fcron");
  });
}

test("a symlinked fcron configuration or deny file is refused without changing its target", () => {
  for (const path of ["/etc/fcron.conf", "/etc/fcron.deny"]) {
    const f = fixture(); f.put("target", "keep\n"); mkdirSync(f.at("/etc"));
    symlinkSync(f.at("target"), f.at(path));
    expect(() => f.sys.denySchedulers("walkie-s1")).toThrow();
    expect(readFileSync(f.at("target"), "utf8")).toBe("keep\n");
  }
});

for (const code of [0, 1]) test(`production reuse guard refuses a running fcron or unknown process list (${code})`, () => {
  const absent = () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); };
  const open = spyOn(fs, "openSync").mockImplementation(absent as never);
  const stat = spyOn(fs, "lstatSync").mockImplementation(absent as never);
  const dirs = spyOn(fs, "readdirSync").mockImplementation(() => [] as never);
  const ps = spyOn(Bun, "spawnSync").mockImplementation((argv) => {
    expect(argv).toEqual(["ps", "-e", "-o", "comm=,args="]);
    return { exitCode: code, stdout: Buffer.from(code ? "" : "vendor-fcron-wrapper /opt/vendor/fcron.conf\n"), stderr: Buffer.alloc(0) } as ReturnType<typeof Bun.spawnSync>;
  });
  try { expect(() => realAdminSys({ platform: "linux" }).denySchedulers("walkie-talkie")).toThrow(/fcron-like/); }
  finally { open.mockRestore(); stat.mockRestore(); dirs.mockRestore(); ps.mockRestore(); }
});

for (const talkie of [false, true]) test(`scheduler refusal precedes account creation (${talkie ? "talkie" : "seat"})`, async () => {
  const f = fixture(); const w = fakeSeatWorld(f.root, f.at("walkie"));
  const create = spyOn(w.sys, "createUser");
  w.sys.denySchedulers = () => { throw new Error("loaded fcron tab cannot be excluded"); };
  try {
    const r = talkie ? await createTalkieUser(w.sys, "11111111-1111-4111-8111-111111111111", "a".repeat(64))
      : await createSeatUser(1, w.sys);
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  } finally { w.sys.ledger().close(); }
});

for (const talkie of [false, true]) test(`real denial is verified before a fake account is created (${talkie ? "talkie" : "seat"})`, async () => {
  const f = fixture(); const w = fakeSeatWorld(f.root, f.at("walkie"));
  const create = w.sys.createUser;
  const sys = { ...w.sys, schedulerFiles: f.sys.schedulerFiles, readSchedulerFile: f.sys.readSchedulerFile,
    denySchedulers: f.sys.denySchedulers, createUser: (u: Parameters<typeof create>[0]) => {
      expect(readFileSync(f.at("/etc/fcron.deny"), "utf8").split("\n")[0]).toBe(u.name);
      expect(schedulerProblem([u.name], f.sys.schedulerFiles, f.sys.readSchedulerFile)).toBeNull();
      create(u);
    } };
  try {
    const r = talkie ? await createTalkieUser(sys, "11111111-1111-4111-8111-111111111111", "a".repeat(64))
      : await createSeatUser(1, sys);
    expect(r.ok).toBe(true);
  } finally { w.sys.ledger().close(); }
});

test("an unverified fcron denial cannot hand out an account even if the writer returns success", async () => {
  const f = fixture(); const w = fakeSeatWorld(f.root, f.at("walkie"));
  const create = spyOn(w.sys, "createUser");
  f.put("/etc/cron.deny", "walkie-s1\n"); f.put("/etc/at.deny", "walkie-s1\n");
  try {
    const r = await createSeatUser(1, { ...w.sys, schedulerFiles: f.sys.schedulerFiles,
      readSchedulerFile: f.sys.readSchedulerFile, denySchedulers: () => {} });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  } finally { w.sys.ledger().close(); }
});
