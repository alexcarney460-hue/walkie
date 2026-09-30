// Root's independent, descriptor-relative check of the seat runner's protected-home report.
import { AT_FDCWD, closeFd, fdIdentity, isDir, listDir, openDirAt, S_IFLNK, S_IFMT, S_IFREG, statAt } from "./fsat.ts";
import type { ResidueProof } from "./sweep.ts";

export function verifySeatHomeResidue(home: string, uid: number, proofs: readonly ResidueProof[]): string | null {
  if (home !== `/Users/walkie-s${uid - 600_000}` || !proofs.length) return "the home residue path is invalid";
  const evidence = new Map<string, ResidueProof>();
  for (const proof of proofs) {
    const parts = proof.path.startsWith(`${home}/`) ? proof.path.slice(home.length + 1).split("/") : [];
    if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
      || !proof.reason.startsWith("EPERM") || evidence.has(proof.path)
      || (proof.dev === undefined) !== (proof.ino === undefined)) return "the home residue proof is invalid";
    evidence.set(proof.path, proof);
  }
  const root = openDirAt(AT_FDCWD(), "/");
  try {
    const usersStat = statAt(root, "Users");
    if (!isDir(usersStat) || usersStat.uid !== 0) return "/Users is not root's real directory";
    const users = openDirAt(root, "Users");
    try {
      if (fdIdentity(users).ino !== usersStat.ino || fdIdentity(users).dev !== usersStat.dev)
        return "/Users changed during residue inspection";
      const name = home.slice(7);
      const homeStat = statAt(users, name);
      if (!isDir(homeStat) || homeStat.uid !== uid) return `${home} is not the seat user's real directory`;
      const homeFd = openDirAt(users, name);
      try {
        const identity = fdIdentity(homeFd);
        if (identity.dev !== homeStat.dev || identity.ino !== homeStat.ino) return `${home} changed during residue inspection`;
        return visit(homeFd, home, 0, identity.dev);
      } finally { closeFd(homeFd); }
    } finally { closeFd(users); }
  } finally { closeFd(root); }

  function visit(dirfd: number, dir: string, depth: number, parentDev: number): string | null {
    if (depth > 200) return `${dir} is too deep to verify`;
    let names: Uint8Array[];
    try { names = listDir(dirfd); } catch (err) { return `${dir} cannot be listed: ${String(err)}`; }
    for (const raw of names) {
      const name = Buffer.from(raw).toString("utf8");
      if (!Buffer.from(name).equals(Buffer.from(raw))) return `${dir} has a name root cannot verify`;
      const path = `${dir}/${name}`;
      let st: ReturnType<typeof statAt>;
      try { st = statAt(dirfd, raw); } catch (err) { return `${path} cannot be checked by root: ${String(err)}`; }
      if (name === ".walkie-seat-home" && depth === 0) {
        if (st.uid !== 0 || (st.mode & S_IFMT) !== S_IFREG) return `${path} is not root's marker`;
        continue;
      }
      if (st.dev !== parentDev) return `${path} is on a different device than its parent`;
      if (st.uid !== uid) return `${path} is not owned by the seat uid`;
      if ((st.mode & S_IFMT) === S_IFLNK) return `${path} is a symbolic link`;
      if ((st.mode & S_IFMT) === S_IFREG && st.nlink !== 1) return `${path} has multiple hard links`;
      const proof = evidence.get(path);
      const childProofs = proofs.some((p) => p.path.startsWith(`${path}/`));
      if (proof) {
        if (proof.dev !== undefined && (proof.dev !== st.dev || proof.ino !== st.ino))
          return `${path} changed since the runner's EPERM observation`;
        evidence.delete(path);
        if (!childProofs) continue;
      }
      if (!isDir(st)) return `${path} is a readable leftover`;
      const child = openDirAt(dirfd, raw);
      try {
        const id = fdIdentity(child);
        if (id.dev !== st.dev || id.ino !== st.ino) return `${path} changed during residue inspection`;
        const why = visit(child, path, depth + 1, id.dev);
        if (why) return why;
      } finally { closeFd(child); }
      if (!childProofs) return `${path} is a readable leftover directory`;
    }
    return depth === 0 && evidence.size ? `the runner reported ${evidence.keys().next().value} but root did not find it` : null;
  }
}
