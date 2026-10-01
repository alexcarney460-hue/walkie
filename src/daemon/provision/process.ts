/** A process identifier includes its start time so a reused PID is not mistaken for an old installer. */
export interface InstallerProcess { readonly pid: number; readonly start: string }

export async function processIdentity(pid: number): Promise<InstallerProcess | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "lstart="], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const start = output.trim();
    return code === 0 && start ? { pid, start } : null;
  } catch { return null; }
}

/** An unreadable process table conservatively keeps an uncertain installer on hold. */
export async function processAlive(saved: InstallerProcess): Promise<boolean> {
  const current = await processIdentity(saved.pid);
  if (current) return current.start === saved.start;
  try { process.kill(saved.pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}
