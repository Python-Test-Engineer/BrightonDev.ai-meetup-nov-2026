import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The path policy of this demo lives here: every file path is resolved by this
 * class before the filesystem is touched.
 *
 *   resolve()      writes - a path outside `workspace/` is refused
 *   resolveRead()  reads  - allowed anywhere, relative paths use the workspace
 *
 * The fence is around mutations, not curiosity: an agent that cannot read the
 * docs, a library or a log outside its own folder is not useful, but one that
 * can write there is a bug. sandbox.js is the layer that turns `resolve()`'s
 * PathError into a shouting FORBIDDEN line. Commands are separate again - see
 * tools.js - because a shell can leave the directory it was started in.
 */

export class PathError extends Error {}

// Shapes that Windows quietly resolves *inside* the workspace if you only
// check containment: "Desktop/notes.txt", "~/x", "%USERPROFILE%/x", "Users/me/x".
const HOME_AND_SYSTEM = new Set([
  'users', 'windows', 'program files', 'program files (x86)', 'programdata',
  'desktop', 'documents', 'downloads', 'appdata', 'onedrive', 'library',
  'system32',
]);

function expandVars(p) {
  let out = p;
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] ?? m);
  return out;
}

// realpath of the deepest existing ancestor + the not-yet-created remainder,
// so a symlinked/junctioned folder cannot smuggle a write outside the root.
function realResolve(abs) {
  let cur = abs;
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class Workspace {
  constructor(root) {
    const abs = path.resolve(root);
    fs.mkdirSync(abs, { recursive: true });
    this.root = fs.realpathSync(abs);
  }

  /** @returns {{abs: string, rel: string}} */
  resolve(requested) {
    if (typeof requested !== 'string' || requested.trim() === '') {
      throw new PathError('path is required (a filename relative to the workspace root)');
    }
    const raw = requested.trim();
    const expanded = expandVars(raw);

    if (/^[A-Za-z]:/.test(raw)) throw new PathError(`absolute or drive-relative path is outside the workspace: ${raw}`);
    if (/^(\\\\|\/\/)/.test(raw)) throw new PathError(`UNC path is outside the workspace: ${raw}`);
    if (path.isAbsolute(expanded)) throw new PathError(`absolute path is outside the workspace: ${raw}`);

    const first = raw.split(/[\\/]/)[0].toLowerCase().replace(/:$/, '');
    if (/^[~$%]/.test(first) && first !== raw) {
      throw new PathError(`home/environment path is outside the workspace: ${raw}`);
    }
    if (HOME_AND_SYSTEM.has(first)) {
      throw new PathError(`"${first}" looks like a home/system folder, not a workspace file: ${raw}`);
    }

    const abs = path.resolve(this.root, expanded);
    const real = realResolve(abs);
    if (!isInside(this.root, real)) {
      throw new PathError(`path escapes the workspace: ${raw}`);
    }

    const rel = path.relative(this.root, real) || '.';
    return { abs: real, rel: rel.split(path.sep).join('/') };
  }

  /**
   * Resolve a path for READING.
   *
   * Reads are deliberately NOT fenced: an agent that cannot read a library, a
   * log or a doc outside its own folder is useless, and the damage a read can
   * do is bounded by what goes into the context window. Only the three mutating
   * actions are confined - that is sandbox.js. Relative paths still resolve
   * against the root, which is what keeps "./notes.txt" meaning the workspace.
   *
   * @returns {{abs: string, rel: string}} rel starts with ".." for an outside path
   */
  resolveRead(requested) {
    if (typeof requested !== 'string' || requested.trim() === '') {
      throw new PathError('path is required (a filename relative to the workspace, or an absolute path)');
    }
    const raw = requested.trim();
    const expanded = expandVars(raw);
    const abs = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(this.root, expanded);
    const real = realResolve(abs);
    const rel = path.relative(this.root, real) || '.';
    return { abs: real, rel: rel.split(path.sep).join('/') };
  }
}
