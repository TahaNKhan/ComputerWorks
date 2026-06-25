// packages/tools-files/src/path-safety.ts
// Shared path-resolution logic for the file tools. Resolves a user-supplied
// path against the session cwd (or an explicit allowed root) and rejects
// anything that escapes via .. or absolute-path tricks.
//
// Per REQUIREMENTS.MD §6: file tools must reject paths escaping the session
// cwd unless the session is configured with explicit additional allowed
// roots. v1 keeps the rule simple: session cwd is the only allowed root.

import { resolve, isAbsolute, relative, sep } from "node:path";

export interface ResolveOptions {
  /** The session's working directory. */
  cwd: string;
  /** Optional explicit allowed root. Defaults to cwd. */
  allowedRoot?: string;
  /** If true, allow absolute paths inside allowedRoot. Default true. */
  allowAbsolute?: boolean;
}

export interface ResolveResult {
  /** Resolved absolute path. */
  absolute: string;
  /** Path relative to allowedRoot. Always starts with no leading "..". */
  relative: string;
}

/**
 * Resolve `input` against the allowed root. Throws a descriptive Error
 * if the resolved path escapes the root.
 *
 * Behaviour:
 *  - Empty string / "." → allowedRoot itself.
 *  - Absolute paths must already be inside allowedRoot (or its subdirs).
 *  - Relative paths are joined to allowedRoot; ".." segments that
 *    escape are rejected.
 */
export function resolveSafe(input: string, opts: ResolveOptions): ResolveResult {
  const root = resolve(opts.allowedRoot ?? opts.cwd);
  const allowAbsolute = opts.allowAbsolute !== false;

  let abs: string;
  if (isAbsolute(input)) {
    if (!allowAbsolute) {
      throw new Error(`absolute paths are not allowed: ${input}`);
    }
    abs = resolve(input);
  } else {
    abs = resolve(root, input);
  }

  const rel = relative(root, abs);
  // If the path escapes via "..", or is on a different drive on Windows,
  // `relative` will start with ".." or contain a separator escape.
  if (rel === "" || (!rel.startsWith("..") && !isAbsOutsideRoot(rel, root, abs))) {
    return { absolute: abs, relative: rel || "." };
  }
  throw new Error(`path escapes allowed root: ${input} (resolved to ${abs})`);
}

/** Sanity check: ensure abs is on the same root or a subdir of root. */
function isAbsOutsideRoot(_rel: string, root: string, abs: string): boolean {
  // If relative() returned a path that starts with the platform separator
  // on a different volume (Windows) the abs path won't start with root.
  if (sep === "/") {
    return !abs.startsWith(root.endsWith(sep) ? root : root + sep);
  }
  // Windows: compare case-insensitively after normalizing.
  const normRoot = root.toLowerCase();
  const normAbs = abs.toLowerCase();
  return !normAbs.startsWith(normRoot.endsWith("\\") ? normRoot : normRoot + "\\");
}

/** True if `child` is `parent` or a descendant of it. */
export function isInside(parent: string, child: string): boolean {
  const normParent = parent.toLowerCase();
  const normChild = child.toLowerCase();
  if (sep === "/") {
    return normChild === normParent || normChild.startsWith(normParent.endsWith(sep) ? normParent : normParent + sep);
  }
  const p = normParent.endsWith("\\") ? normParent : normParent + "\\";
  return normChild === normParent || normChild.startsWith(p);
}
