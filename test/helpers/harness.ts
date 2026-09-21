import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isActionable, runCommand, type ToolResult } from 'pi-helper-core';
import { captureTools, type CapturedTool } from '../../scripts/tool-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', 'fixtures');

const tools = captureTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

export function allTools(): CapturedTool[] {
  return tools;
}

export function fakeContext(cwd: string, options: { confirm?: boolean } = {}): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    mode: 'json',
    ui: {
      confirm: async () => options.confirm ?? true,
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}

/** Call a registered tool exactly the way the agent would. */
export async function invokeTool<T = unknown>(
  name: string,
  params: unknown,
  cwd: string,
  options: { confirm?: boolean } = {},
): Promise<ToolResult<T>> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ details?: unknown }>;
  const result = await call('test-call', params, undefined, undefined, fakeContext(cwd, options));
  return result.details as ToolResult<T>;
}

/**
 * Copy a fixture into a temporary directory and point cargo at a throwaway
 * target directory, so a test run never leaves anything behind or reuses a
 * stale build.
 */
export async function withFixture(
  name: string,
  run: (directory: string) => Promise<void> | void,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'pi-rust-helper-'));
  const directory = join(parent, name);
  await cp(join(FIXTURES, name), directory, { recursive: true });
  const previous = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = join(parent, 'target');
  try {
    await run(directory);
  } finally {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
    await rm(parent, { recursive: true, force: true });
  }
}

/** Write Cargo.lock by resolving offline, which a `--locked` run then requires. */
export async function primeLockfile(directory: string): Promise<void> {
  await runCommand('cargo', ['metadata', '--format-version', '1', '--offline'], {
    cwd: directory,
    timeoutMs: 120000,
    maxBytes: 1024 * 1024,
  });
}

let rustChecked: boolean | undefined;

export async function rustAvailable(): Promise<boolean> {
  // `PI_RUST_HELPER_NO_RUST=1` lets CI exercise the skip path on a runner that
  // already has a Rust toolchain installed.
  if (process.env.PI_RUST_HELPER_NO_RUST === '1') return false;
  if (rustChecked !== undefined) return rustChecked;
  const result = await runCommand('rustc', ['--version'], {
    cwd: FIXTURES,
    timeoutMs: 15000,
    maxBytes: 32 * 1024,
  });
  rustChecked = result.code === 0;
  return rustChecked;
}

/**
 * The envelope contract the core promises every tool obeys. Asserting it here,
 * at the tool boundary, is what keeps a helper from inventing a second shape.
 */
export function assertEnvelope(value: ToolResult, label: string): void {
  assert.equal(typeof value.ok, 'boolean', `${label}: ok must be a boolean`);
  assert.equal(typeof value.attention, 'boolean', `${label}: attention must be a boolean`);
  assert.equal(
    value.attention,
    !value.ok || isActionable(value),
    `${label}: attention must be derived from ok, warnings, and errors`,
  );
  if (!value.ok) {
    assert.ok(
      isActionable(value),
      `${label}: ok:false must carry at least one actionable diagnostic`,
    );
  }
  assert.ok(Array.isArray(value.evidence), `${label}: evidence must be an array`);
  assert.ok(value.metadata, `${label}: metadata is required`);
  assert.equal(typeof value.metadata.toolVersion, 'string');
  assert.equal(typeof value.metadata.durationMs, 'number');
  for (const entry of [...value.warnings, ...value.errors]) {
    assert.ok(['info', 'warning', 'error'].includes(entry.severity), `${label}: bad severity`);
    assert.equal(typeof entry.message, 'string');
  }
}

export function warningCodes(value: ToolResult): string[] {
  return value.warnings.map((entry) => entry.code ?? '');
}

export function errorCodes(value: ToolResult): string[] {
  return value.errors.map((entry) => entry.code ?? '');
}
