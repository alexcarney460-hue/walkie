// These fixtures create their own local cluster; never use an external database URL.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function postgresBinaries(): { initdb: string; pgctl: string } {
  const onPath = Bun.which("initdb");
  const config = Bun.which("pg_config");
  const configured = config ? spawnSync(config, ["--bindir"], { encoding: "utf8" }) : null;
  const dirs = [
    ...(onPath ? [dirname(onPath)] : []),
    ...(configured?.status === 0 && configured.stdout.trim() ? [configured.stdout.trim()] : []),
    "/opt/homebrew/bin",
  ];
  for (const dir of dirs) {
    const initdb = join(dir, "initdb"), pgctl = join(dir, "pg_ctl");
    try {
      if (!statSync(initdb).isFile() || !statSync(pgctl).isFile()) continue;
      if (dirname(realpathSync(initdb)) !== dirname(realpathSync(pgctl))) continue;
      accessSync(initdb, constants.X_OK);
      accessSync(pgctl, constants.X_OK);
      return { initdb, pgctl };
    } catch { /* Both tools must exist in the same installation. */ }
  }
  throw new Error("Postgres fixture requires matching initdb and pg_ctl on PATH or in pg_config --bindir");
}
