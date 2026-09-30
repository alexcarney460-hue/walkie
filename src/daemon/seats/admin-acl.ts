// macOS extended ACLs on already verified directory handles. No pathname is resolved here.
type Ptr = import("bun:ffi").Pointer;
const ACL_TYPE_EXTENDED = 0x100;

function aclApi() {
  if (process.platform !== "darwin") throw new Error("macOS ACL inspection is unavailable");
  const { dlopen, FFIType: T, toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
  const symbols = (dlopen("libSystem.B.dylib", {
    acl_get_fd_np: { args: [T.i32, T.i32], returns: T.ptr },
    acl_get_entry: { args: [T.ptr, T.i32, T.ptr], returns: T.i32 },
    acl_get_tag_type: { args: [T.ptr, T.ptr], returns: T.i32 },
    acl_get_permset: { args: [T.ptr, T.ptr], returns: T.i32 },
    acl_get_perm_np: { args: [T.ptr, T.i32], returns: T.i32 },
    acl_init: { args: [T.i32], returns: T.ptr },
    acl_set_fd_np: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
    acl_free: { args: [T.ptr], returns: T.i32 },
    __error: { args: [], returns: T.ptr },
  }) as unknown as { symbols: {
    acl_get_fd_np: (fd: number, kind: number) => Ptr | null;
    acl_get_entry: (acl: Ptr, entry: number, out: BigUint64Array) => number;
    acl_get_tag_type: (entry: Ptr, out: Int32Array) => number;
    acl_get_permset: (entry: Ptr, out: BigUint64Array) => number;
    acl_get_perm_np: (perms: Ptr, permission: number) => number;
    acl_init: (count: number) => Ptr | null;
    acl_set_fd_np: (fd: number, acl: Ptr, kind: number) => number;
    acl_free: (acl: Ptr) => number;
    __error: () => Ptr;
  } }).symbols;
  return { ...symbols, errno: () => new Int32Array(toArrayBuffer(symbols.__error(), 0, 4))[0] as number };
}

/** Refuse any allow ACE that can mutate the directory or entries within it. */
export function aclAllowsWrite(fd: number): boolean {
  const a = aclApi();
  const acl = a.acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) {
    if (a.errno() === 2) return false;
    throw new Error("extended ACL could not be read");
  }
  try {
    const entry = new BigUint64Array(1);
    for (let i = 0; i < 170; i++) {
      const result = a.acl_get_entry(acl, i, entry);
      if (result === -1 && (a.errno() === 2 || i > 0 && a.errno() === 22)) return false;
      if (result !== 0) throw new Error("extended ACL entries could not be read");
      const tag = new Int32Array(1);
      if (a.acl_get_tag_type(Number(entry[0]) as Ptr, tag) !== 0) throw new Error("extended ACL tag could not be read");
      if (tag[0] !== 1) continue; // deny entries do not grant access
      const perms = new BigUint64Array(1);
      if (a.acl_get_permset(Number(entry[0]) as Ptr, perms) !== 0) throw new Error("extended ACL permissions could not be read");
      for (const permission of [1 << 2, 1 << 4, 1 << 5, 1 << 6, 1 << 8, 1 << 10, 1 << 12, 1 << 13]) {
        const has = a.acl_get_perm_np(Number(perms[0]) as Ptr, permission);
        if (has < 0) throw new Error("extended ACL permission could not be read");
        if (has === 1) return true;
      }
    }
    throw new Error("extended ACL has too many entries");
  } finally { a.acl_free(acl); }
}

/** Fail closed on any extended ACL; no entry can grant non-root access if there are no entries. */
export function hasExtendedAcl(fd: number): boolean {
  const a = aclApi();
  const acl = a.acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) {
    if (a.errno() === 2) return false;
    throw new Error("extended ACL could not be read");
  }
  try {
    const out = new BigUint64Array(1);
    const result = a.acl_get_entry(acl, 0, out);
    if (result === 0) return true;
    if (result === -1 && a.errno() === 2) return false;
    throw new Error("extended ACL entries could not be read");
  } finally { a.acl_free(acl); }
}

/** Remove all ACL entries on the handle and verify they are gone. */
export function stripExtendedAcl(fd: number): void {
  const a = aclApi();
  const empty = a.acl_init(0);
  if (!empty) throw new Error("empty extended ACL could not be made");
  try {
    if (a.acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED) !== 0) throw new Error("extended ACL could not be removed");
  } finally { a.acl_free(empty); }
  if (hasExtendedAcl(fd)) throw new Error("extended ACL remains after removal");
}
