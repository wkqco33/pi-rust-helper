import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SelectionSignals, TddSignals } from 'pi-helper-core';
import type { RustProjectModel } from './metadata.ts';

/**
 * Rust file classification and module naming for the shared selection algorithm.
 *
 * Cargo collects tests from `<crate>/tests/*.rs` and from `#[cfg(test)]` modules
 * inside the crate, so a changed file maps to a *crate* target rather than to a
 * specific test file. The shared ranker still narrows candidates; the crate
 * mapping is what turns the result into `cargo test -p <crate>`.
 */

const PREFIX_TOKENS = new Set([
  'src',
  'lib',
  'main',
  'bin',
  'tests',
  'test',
  'crates',
  'crate',
  'packages',
  'package',
  'mod',
  'examples',
  'benches',
  'toml',
  'rs',
]);

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

export function baseName(path: string): string {
  const posix = toPosix(path);
  return posix.slice(posix.lastIndexOf('/') + 1);
}

export function isSourceFile(path: string): boolean {
  const normalized = toPosix(path);
  return normalized.endsWith('.rs') || baseName(normalized) === 'Cargo.toml';
}

/** Integration tests live in `tests/`; `_test.rs` covers explicit naming. */
export function isTestFile(path: string): boolean {
  const normalized = toPosix(path);
  return /(^|\/)tests\//.test(normalized) || /_test\.rs$/.test(normalized);
}

/** Cargo only builds `.rs` files that sit directly in `tests/` as test crates. */
export function isRunnableTestFile(path: string): boolean {
  return /(^|\/)tests\/[^/]+\.rs$/.test(toPosix(path));
}

export function pathTokens(path: string): string[] {
  return toPosix(path)
    .replace(/\.[A-Za-z0-9]+$/, '')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !PREFIX_TOKENS.has(token));
}

/** `crates/core/src/foo/bar.rs` -> the module path plus the crate-relative one. */
export function moduleNamesForFile(path: string): string[] {
  const normalized = toPosix(path).replace(/\.rs$/, '');
  const marker = normalized.includes('/src/')
    ? '/src/'
    : normalized.startsWith('src/')
      ? 'src/'
      : undefined;
  const crate = crateDirectory(path);
  let relative = marker ? normalized.slice(normalized.indexOf(marker) + marker.length) : normalized;
  // Integration tests, benches, and examples are separate crates: the directory
  // is a cargo convention, not part of the module path.
  relative = relative.replace(/^(?:tests|benches|examples)\//, '');
  const segments = relative.split('/').filter((segment) => segment.length > 0 && segment !== 'mod');
  const names = new Set<string>();
  if (segments.length === 0) {
    names.add('crate');
    if (crate) names.add(crate);
    return [...names];
  }
  let joined = segments.join('::');
  if (joined.endsWith('::lib') || joined.endsWith('::main'))
    joined = joined.replace(/::(lib|main)$/, '');
  if (!joined) {
    names.add('crate');
    if (crate) names.add(crate);
    return [...names];
  }
  names.add(joined);
  names.add(`crate::${joined}`);
  if (crate) names.add(`${crate}::${joined}`);
  const last = segments[segments.length - 1];
  names.add(last);
  return [...names];
}

/** First path segment when it is a workspace container, else the crate dir. */
export function crateDirectory(path: string): string | undefined {
  const segments = toPosix(path).split('/');
  if ((segments[0] === 'crates' || segments[0] === 'packages') && segments.length > 1) {
    return segments[1];
  }
  if (segments[0] === 'src' || segments[0] === 'tests' || segments[0] === 'benches')
    return undefined;
  return segments[0];
}

export function packageNameFromPath(path: string): string {
  return crateDirectory(path) ?? '';
}

export const RUST_SELECTION_SIGNALS: SelectionSignals = {
  isSourceFile,
  isTestFile,
  isRunnableTestFile,
  pathTokens,
  moduleNamesForFile,
  packageName: packageNameFromPath,
  supportFileNames: new Set(['common.rs', 'mod.rs']),
  testNameAffixes: { prefixes: [], suffixes: [] },
};

export const RUST_TDD_SIGNALS: TddSignals = {
  isSourceFile,
  isTestFile,
  prefixTokens: PREFIX_TOKENS,
  minTokenLength: 3,
};

/**
 * The workspace member whose directory contains the path.
 *
 * Matching on the member's manifest directory (not on its package name) is what
 * makes `crates/app` containing package `probe-app` resolve correctly.
 */
export function memberForPath(model: RustProjectModel, path: string): string | undefined {
  const normalized = toPosix(path);
  for (const member of model.members) {
    const relativeRoot = toPosix(member.root.slice(model.root.length)).replace(/^\/+/, '');
    if (normalized.startsWith(`${relativeRoot}/`) || normalized === relativeRoot)
      return member.name;
  }
  // A crate at the workspace root owns `src/` and `tests/` directly.
  const rootMember = model.members.find((member) => member.root === model.root);
  if (rootMember && /^(src|tests|benches|examples|build\.rs)/.test(normalized))
    return rootMember.name;
  return undefined;
}

/** Widen a set of crates to include everything that depends on them. */
export function withDependents(model: RustProjectModel, crates: string[]): string[] {
  const affected = new Set<string>();
  const queue = [...crates];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (affected.has(current)) continue;
    affected.add(current);
    for (const dependent of model.reverseDependencies[current] ?? []) queue.push(dependent);
  }
  return [...affected].sort();
}

export interface RustSelection {
  changedCrates: string[];
  /** `changedCrates` plus reverse dependencies, which is what has to be retested. */
  affectedCrates: string[];
  unmatched: string[];
}

export function cratesForChangedFiles(
  model: RustProjectModel,
  changedPaths: string[],
): RustSelection {
  const changedCrates = new Set<string>();
  const unmatched: string[] = [];
  for (const path of changedPaths) {
    const normalized = toPosix(path);
    if (!isSourceFile(normalized)) continue;
    // A root manifest or lockfile change can affect every member.
    if (!normalized.includes('/') && (normalized === 'Cargo.toml' || normalized === 'Cargo.lock')) {
      for (const member of model.members) changedCrates.add(member.name);
      continue;
    }
    const member = memberForPath(model, normalized);
    if (member) changedCrates.add(member);
    else unmatched.push(normalized);
  }
  const crates = [...changedCrates].sort();
  return { changedCrates: crates, affectedCrates: withDependents(model, crates), unmatched };
}

/** Directories cargo collects integration tests from, relative to the root. */
export function rustTestDirectories(model: RustProjectModel): string[] {
  return model.members
    .map((member) => toPosix(member.root.slice(model.root.length)).replace(/^\/+/, ''))
    .map((relative) => (relative ? `${relative}/tests` : 'tests'));
}

/** Integration-test files cargo would build, as workspace-relative paths. */
export async function listRustTestFiles(model: RustProjectModel): Promise<string[]> {
  const files = new Set<string>();
  for (const directory of rustTestDirectories(model)) {
    const entries = await readdir(join(model.root, directory), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.rs')) {
        files.add(toPosix(`${directory}/${entry.name}`));
      }
    }
  }
  return [...files].sort();
}
