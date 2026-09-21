import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeclaredDependency, RustProjectModel } from './metadata.ts';

/**
 * Unused-dependency detection.
 *
 * Cargo's resolved graph says a dependency exists, never whether the source
 * references it, so this needs a bounded source scan. It is deliberately a
 * separate, opt-in step: the scan reads every `.rs` file under a member, and the
 * result is only a hint. A dependency referenced by a derive macro, a
 * `#[serde(...)]` attribute, or a build script can look unused from source text
 * alone, so findings are informational rather than errors.
 */

export interface UnusedDependency {
  member: string;
  dependency: string;
  crate: string;
  kind: DeclaredDependency['kind'];
}

export interface UnusedDependencyReport {
  scanned: boolean;
  filesScanned: number;
  findings: UnusedDependency[];
  /** Populated when the scan hit its budget, so an empty list is not overclaimed. */
  incompleteReason?: string;
}

export interface UnusedScanOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const IGNORED_DIRECTORIES = new Set(['target', 'node_modules', '.git', '.cargo', '.rustup']);

/**
 * `-` becomes `_` and the reference must not be part of a longer identifier.
 * `\b` cannot be used because `_` is a word character.
 */
export function cratePattern(crate: string): RegExp {
  const escaped = crate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

async function listRustFiles(
  root: string,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) return { files, truncated: true };
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        files.push(path);
      }
    }
  }
  return { files, truncated: false };
}

async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

/** Declared dependencies that no `.rs` file under the member references. */
export async function findUnusedDependencies(
  model: RustProjectModel,
  options: UnusedScanOptions = {},
): Promise<UnusedDependencyReport> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const findings: UnusedDependency[] = [];
  let filesScanned = 0;
  let totalBytes = 0;
  let incompleteReason: string | undefined;

  for (const member of model.members) {
    // Optional dependencies exist only when a feature enables them, so an
    // unreferenced optional dependency is expected rather than a hint.
    const remaining = new Map<string, DeclaredDependency>();
    for (const dependency of member.declared) {
      if (dependency.optional) continue;
      if (!remaining.has(dependency.crate)) remaining.set(dependency.crate, dependency);
    }
    if (remaining.size === 0) continue;

    const { files, truncated } = await listRustFiles(member.root, maxFiles);
    if (truncated && incompleteReason === undefined) {
      incompleteReason = `${member.name}: more than ${maxFiles} Rust files were found, so the scan stopped early.`;
    }

    const patterns = new Map([...remaining.keys()].map((crate) => [crate, cratePattern(crate)]));
    for (const file of files) {
      if (remaining.size === 0) break;
      if (totalBytes >= maxTotalBytes) {
        incompleteReason ??= `The scan stopped after ${Math.round(maxTotalBytes / (1024 * 1024))} MiB of source, so some members were not checked.`;
        break;
      }
      const text = await readBounded(file, maxFileBytes);
      if (text === undefined) continue;
      filesScanned += 1;
      totalBytes += Buffer.byteLength(text, 'utf8');
      for (const [crate, pattern] of patterns) {
        if (pattern.test(text)) {
          remaining.delete(crate);
          patterns.delete(crate);
        }
      }
      if (totalBytes >= maxTotalBytes && remaining.size > 0 && incompleteReason === undefined) {
        incompleteReason = `The scan stopped after ${Math.round(maxTotalBytes / (1024 * 1024))} MiB of source, so some members were not checked.`;
      }
    }
    for (const dependency of remaining.values()) {
      findings.push({
        member: member.name,
        dependency: dependency.name,
        crate: dependency.crate,
        kind: dependency.kind,
      });
    }
  }

  findings.sort(
    (left, right) =>
      left.member.localeCompare(right.member) || left.dependency.localeCompare(right.dependency),
  );
  return { scanned: true, filesScanned, findings, incompleteReason };
}
