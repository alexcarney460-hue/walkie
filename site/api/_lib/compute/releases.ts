// The Sqwakie releases a rented machine may install (REVIEW-opus.md P2-9). The release tag goes straight into the
// machine's user-data, and a tag that was never published makes the installer fail, which ends the rental as a boot
// failure whose time is refunded: an unchecked tag lets anyone burn provider time for free. Only these tags are
// accepted by /api/compute/rent and /api/compute/start.
//
// Being listed is NOT proof of publication: the list is kept in step with this checkout's own release (package.json and
// the installers' DEFAULT_VERSION, which site/test/compute-golive-d.test.ts enforces), and that release may not be on
// GitHub (walkie-releases) yet. At this commit v0.2.0-pre.21 is listed and was not yet published; v0.2.0-pre.17,
// v0.2.0-pre.18, v0.2.0-pre.19 and v0.2.0-pre.20 stay listed. Before COMPUTE_ENABLED=1, every listed tag must resolve with `gh release view <tag> -R alexcarney460-hue/walkie-releases`
// (the go-live gate, docs/COMPUTE-GOLIVE.md). Releases before pre.17 never rent (their compute lock is off), so the list
// holds the compute-capable releases only. Append the new tag in each release prep commit, the one that bumps
// package.json and DEFAULT_VERSION.
export const RENTED_MACHINE_RELEASES: readonly string[] = ["v0.2.0-pre.17", "v0.2.0-pre.18", "v0.2.0-pre.19", "v0.2.0-pre.20", "v0.2.0-pre.21"];

const ALLOWED: ReadonlySet<string> = new Set(RENTED_MACHINE_RELEASES);

/** True when a rented machine may be pinned to this release tag. */
export function rentableRelease(tag: string): boolean {
  return ALLOWED.has(tag);
}
