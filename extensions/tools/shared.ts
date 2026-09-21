import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { findProjectRoot } from '../../src/rust/metadata.ts';

export type Pi = ExtensionAPI;
export type Ctx = ExtensionContext;

/**
 * Every tool returns JSON text plus the same object in `details`, so the UI can
 * render structured results while the model reads a single stable document.
 */
export function text(value: unknown): {
  content: { type: 'text'; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readTextIfExists(
  path: string,
  maxBytes = 256 * 1024,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface LocatedProject {
  root?: string;
  manifest?: string;
  error?: string;
}

/**
 * Accept a project directory, a `Cargo.toml` path, or nothing (the current
 * directory). Never assume the caller passed a directory.
 */
export async function resolveProject(cwd: string, requested?: string): Promise<LocatedProject> {
  if (!requested) {
    const root = await findProjectRoot(cwd);
    return root ? { root, manifest: `${root}/Cargo.toml` } : { root: cwd };
  }
  const candidate = resolve(cwd, requested);
  if (basename(candidate) === 'Cargo.toml') {
    if ((await readTextIfExists(candidate)) === undefined) {
      return { error: `No Cargo.toml exists at ${candidate}.` };
    }
    return { root: dirname(candidate), manifest: candidate };
  }
  if (await isDirectory(candidate)) {
    const root = (await findProjectRoot(candidate)) ?? candidate;
    return { root, manifest: `${root}/Cargo.toml` };
  }
  return {
    error: `No Rust project was found at ${candidate}. Pass a directory or a Cargo.toml path.`,
  };
}

export function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** `git diff --name-only` output, used when the caller passes no changed paths. */
export async function changedPathsFromGit(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ paths: string[]; source: string }> {
  const { runCommand } = await import('pi-helper-core');
  const result = await runCommand('git', ['diff', '--name-only', 'HEAD'], {
    cwd,
    signal,
    timeoutMs: 15000,
    maxBytes: 256 * 1024,
  });
  if (result.code !== 0) {
    return { paths: [], source: result.stderr.trim().slice(0, 200) || 'git diff failed' };
  }
  return {
    paths: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    source: 'git diff',
  };
}
