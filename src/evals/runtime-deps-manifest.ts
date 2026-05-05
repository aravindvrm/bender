/**
 * Runtime-extension manifest.
 *
 * Optional features that are too heavy to ship inside the DMG live as
 * downloadable bundles on this repo's GitHub Releases. Bender pins a
 * specific bundle revision per extension; the install flow fetches that
 * exact tarball, verifies its SHA-256, and unpacks it under
 * `~/.bender/runtime-deps/<id>/<bundleVersion>/`.
 *
 * Bundle revisions are independent of bender's own version: we bump the
 * `bundleVersion` here only when the upstream package or our wrapper
 * code requires a different tarball. That way patch releases of bender
 * don't churn 150 MB of unchanged release assets.
 *
 * To bump a bundle:
 *   1. Update `extensions/<id>/version.json` to a new bundleVersion.
 *   2. Run the matching workflow on GitHub (workflow_dispatch).
 *   3. Update this file with the new url + sha256 + sizeBytes.
 *   4. Commit both — the version.json bump and the manifest update.
 */

export interface RuntimeExtensionManifest {
  /** Stable identifier — used as the install dir name. */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Bender's bundle revision. Bumps independently of bender's version. */
  bundleVersion: number;
  /** Upstream package version pinned in this bundle. Informational. */
  upstreamVersion: string;
  /** Asset URL on GitHub Releases. Must match bundleVersion. */
  url: string;
  /** Hex-encoded SHA-256 of the tarball at `url`. */
  sha256: string;
  /** Approximate size in bytes. Shown to the user before download. */
  sizeBytes: number;
}

/** Sentinel sha256 used while a bundle hasn't been published yet. */
export const UNPUBLISHED_SHA256 = "unpublished";

const _MANIFEST = {
  promptfoo: {
    id: "promptfoo",
    label: "Eval support (promptfoo)",
    bundleVersion: 1,
    upstreamVersion: "0.120.19",
    url: "https://github.com/aravindvrm/bender/releases/download/promptfoo-bundle-v1/promptfoo-v1.tar.gz",
    sha256: "c0eb1c529cb21c1988cfc1b2bb4d29d9f0ba60253f5cb648262cb5b82f762a5d",
    sizeBytes: 42_348_632,
  },
} satisfies Record<string, RuntimeExtensionManifest>;

// Widened so `sha256 === UNPUBLISHED_SHA256` checks aren't narrowed away
// when a manifest entry happens to have a real hash committed.
export const RUNTIME_EXTENSIONS: Record<keyof typeof _MANIFEST, RuntimeExtensionManifest> = _MANIFEST;

export type RuntimeExtensionId = keyof typeof _MANIFEST;
