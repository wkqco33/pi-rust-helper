import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AdapterContext, CommandPreview, Diagnostic, ToolchainInfo } from 'pi-helper-core';
import { isSpawnFailure, runCommand, warn } from 'pi-helper-core';
import { metadataCommand } from './commands.ts';

/**
 * Toolchain discovery.
 *
 * Every check here reads the file system instead of asking rustup. rustup 1.29
 * auto-installs a toolchain named by `rust-toolchain.toml` — even for
 * `rustup toolchain list` and `rustup show` — so shelling out before comparing
 * the declared channel against the installed set can silently download hundreds
 * of megabytes. Reading `~/.rustup/toolchains` is exact and side-effect free.
 */

export interface RustcInfo {
  version: string;
  release: string;
  host: string;
  commitHash?: string;
  commitDate?: string;
  llvm?: string;
  binary?: string;
}

export interface CargoInfo {
  version: string;
}

export interface RustupInfo {
  available: boolean;
  home: string;
  defaultToolchain?: string;
  installed: string[];
  /** A `rustup override set` entry that applies to the inspected directory. */
  directoryOverride?: { directory: string; toolchain: string };
}

export interface ToolchainFileInfo {
  path: string;
  legacy: boolean;
  channel?: string;
  components: string[];
  targets: string[];
  profile?: string;
}

export interface ToolchainReport {
  toolchain: ToolchainInfo;
  rustc?: RustcInfo;
  cargo?: CargoInfo;
  rustup: RustupInfo;
  toolchainFile?: ToolchainFileInfo;
  /** The toolchain a command run in this directory would actually use. */
  effectiveChannel?: string;
  warnings: Diagnostic[];
  errors: Diagnostic[];
  commands: CommandPreview[];
}

export function parseRustcVv(text: string): RustcInfo | undefined {
  const release = text.match(/^release:\s*(\S+)/m)?.[1];
  const host = text.match(/^host:\s*(\S+)/m)?.[1];
  if (!release || !host) return undefined;
  return {
    version: text.match(/^rustc\s+(\S+)/m)?.[1] ?? release,
    release,
    host,
    commitHash: text.match(/^commit-hash:\s*(\S+)/m)?.[1],
    commitDate: text.match(/^commit-date:\s*(\S+)/m)?.[1],
    llvm: text.match(/^LLVM version:\s*(\S+)/m)?.[1],
    binary: text.match(/^binary:\s*(\S+)/m)?.[1],
  };
}

export function parseCargoVersion(text: string): CargoInfo | undefined {
  const version = text.match(/^cargo\s+(\S+)/m)?.[1];
  return version ? { version } : undefined;
}

function quotedValues(body: string): string[] {
  return [...body.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

/** Parse `rust-toolchain.toml`, falling back to the legacy one-line file. */
export function parseToolchainFile(
  text: string,
  legacy: boolean,
): Pick<ToolchainFileInfo, 'legacy' | 'channel' | 'components' | 'targets' | 'profile'> {
  if (legacy) {
    const channel = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'));
    return { legacy: true, channel, components: [], targets: [] };
  }
  const stripped = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s#.*$/, ''))
    .join('\n');
  return {
    legacy: false,
    channel: stripped.match(/^\s*channel\s*=\s*"([^"]*)"/m)?.[1],
    profile: stripped.match(/^\s*profile\s*=\s*"([^"]*)"/m)?.[1],
    components: quotedValues(stripped.match(/^\s*components\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''),
    targets: quotedValues(stripped.match(/^\s*targets\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''),
  };
}

/** `rustup` stores its default and per-directory overrides in this file. */
export function parseRustupSettings(text: string): {
  defaultToolchain?: string;
  overrides: Record<string, string>;
} {
  const defaultToolchain = text.match(/^\s*default_toolchain\s*=\s*"([^"]*)"/m)?.[1];
  const overrides: Record<string, string> = {};
  const section = text.match(/\[overrides\]([\s\S]*)$/)?.[1] ?? '';
  for (const match of section.matchAll(/^\s*"([^"]+)"\s*=\s*"([^"]*)"/gm)) {
    overrides[match[1]] = match[2];
  }
  return { defaultToolchain, overrides };
}

/**
 * True when a channel names the same toolchain as an installed directory name.
 * `stable` matches `stable-x86_64-unknown-linux-gnu`, and a fully qualified
 * channel matches exactly.
 */
export function channelMatches(channel: string, toolchainName: string): boolean {
  const left = channel.trim().toLowerCase();
  const right = toolchainName.trim().toLowerCase();
  return left === right || right.startsWith(`${left}-`);
}

/** A toolchain file may name a path instead of a channel; those need no check. */
export function isChannelName(channel: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(channel.trim());
}

export function installedToolchains(toolchainsDir: string): Promise<string[]> {
  return readdir(toolchainsDir, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    )
    .catch(() => []);
}

async function readTextIfExists(path: string, maxBytes = 64 * 1024): Promise<string | undefined> {
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

/** Nearest `rust-toolchain.toml`/`rust-toolchain`, walking up like rustup does. */
export async function findToolchainFile(
  start: string,
): Promise<{ path: string; text: string; legacy: boolean } | undefined> {
  let directory = resolve(start);
  for (let depth = 0; depth < 32; depth += 1) {
    for (const name of ['rust-toolchain.toml', 'rust-toolchain']) {
      const path = join(directory, name);
      const text = await readTextIfExists(path);
      if (text !== undefined) return { path, text, legacy: name === 'rust-toolchain' };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The longest `[overrides]` key that prefixes the inspected directory. */
export function matchDirectoryOverride(
  overrides: Record<string, string>,
  directory: string,
): { directory: string; toolchain: string } | undefined {
  const normalized = resolve(directory);
  let best: { directory: string; toolchain: string } | undefined;
  for (const [key, toolchain] of Object.entries(overrides)) {
    const base = resolve(key);
    if (normalized === base || normalized.startsWith(`${base}/`)) {
      if (!best || base.length > best.directory.length) best = { directory: key, toolchain };
    }
  }
  return best;
}

async function run(
  executable: string,
  args: string[],
  ctx: AdapterContext,
  timeoutMs: number,
): Promise<{ text: string; ok: boolean; spawnFailure: boolean }> {
  const result = await runCommand(executable, args, {
    cwd: ctx.projectRoot ?? ctx.cwd,
    signal: ctx.signal,
    timeoutMs,
    maxBytes: 64 * 1024,
  });
  return {
    text: `${result.stdout}${result.stderr}`,
    ok: result.code === 0 && !result.timedOut,
    spawnFailure: isSpawnFailure(result),
  };
}

export async function inspectToolchain(ctx: AdapterContext): Promise<ToolchainReport> {
  const cwd = ctx.projectRoot ?? ctx.cwd;
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const commands: CommandPreview[] = [];

  const file = await findToolchainFile(cwd);
  const toolchainFile: ToolchainFileInfo | undefined = file
    ? { path: file.path, ...parseToolchainFile(file.text, file.legacy) }
    : undefined;

  const home = process.env.RUSTUP_HOME ?? join(homedir(), '.rustup');
  const installed = await installedToolchains(join(home, 'toolchains'));
  const settingsText = await readTextIfExists(join(home, 'settings.toml'));
  const settings = settingsText ? parseRustupSettings(settingsText) : { overrides: {} };
  const directoryOverride = matchDirectoryOverride(settings.overrides ?? {}, cwd);
  const rustup: RustupInfo = {
    available: installed.length > 0 || settingsText !== undefined,
    home,
    defaultToolchain: settings.defaultToolchain,
    installed,
    directoryOverride,
  };

  const envOverride = process.env.RUSTUP_TOOLCHAIN?.trim();
  const declaredChannel = toolchainFile?.channel?.trim();
  // rustup prefers the directory override over the default, and a
  // `rust-toolchain.toml` in the directory tree overrides both.
  const effectiveChannel = declaredChannel ?? directoryOverride?.toolchain ?? envOverride;

  const declaredIsChannel = declaredChannel ? isChannelName(declaredChannel) : false;
  const declaredInstalled =
    !declaredIsChannel || installed.some((name) => channelMatches(declaredChannel as string, name));

  // Refuse to run rustc before proving the declared channel is installed: the
  // rustup shim would install it instead of failing.
  if (rustup.available && declaredChannel && declaredIsChannel && !declaredInstalled) {
    errors.push({
      code: 'TOOLCHAIN_NOT_INSTALLED',
      message: `rust-toolchain.toml names the "${declaredChannel}" channel, which is not installed. Running cargo here would make rustup download it.`,
      severity: 'error',
      path: file?.path,
    });
  }
  if (
    envOverride &&
    isChannelName(envOverride) &&
    !installed.some((n) => channelMatches(envOverride, n))
  ) {
    errors.push({
      code: 'TOOLCHAIN_NOT_INSTALLED',
      message: `RUSTUP_TOOLCHAIN names "${envOverride}", which is not installed. Running cargo would make rustup download it.`,
      severity: 'error',
    });
  }

  if (
    declaredChannel &&
    directoryOverride &&
    !channelMatches(declaredChannel, directoryOverride.toolchain)
  ) {
    warnings.push(
      warn(
        'TOOLCHAIN_FILE_MISMATCH',
        `rust-toolchain.toml names "${declaredChannel}" but a rustup directory override pins "${directoryOverride.toolchain}" for ${directoryOverride.directory}.`,
        file?.path,
      ),
    );
  }
  if (declaredChannel && !rustup.available) {
    warnings.push(
      warn(
        'TOOLCHAIN_FILE_MISMATCH',
        `rust-toolchain.toml names "${declaredChannel}" but rustup is not available, so the file has no effect on the toolchain that runs.`,
        file?.path,
      ),
    );
  }

  const blocked = errors.length > 0;
  let rustc: RustcInfo | undefined;
  let cargo: CargoInfo | undefined;

  if (!blocked) {
    const rustcRun = await run('rustc', ['-vV'], ctx, 15000);
    commands.push({ executable: 'rustc', args: ['-vV'], cwd, risk: 'read' });
    if (rustcRun.spawnFailure) {
      errors.push({
        code: 'RUST_NOT_INSTALLED',
        message: 'rustc is not available on PATH, so no Rust toolchain can run.',
        severity: 'error',
      });
    } else if (rustcRun.ok) {
      rustc = parseRustcVv(rustcRun.text);
    } else {
      errors.push({
        code: 'RUSTC_FAILED',
        message: 'rustc -vV did not complete, so the active toolchain is unknown.',
        severity: 'error',
      });
    }

    const cargoRun = await run('cargo', ['--version'], ctx, 15000);
    commands.push({ executable: 'cargo', args: ['--version'], cwd, risk: 'read' });
    if (cargoRun.spawnFailure) {
      errors.push({
        code: 'CARGO_NOT_INSTALLED',
        message: 'cargo is not available on PATH, so no cargo command can run.',
        severity: 'error',
      });
    } else if (cargoRun.ok) {
      cargo = parseCargoVersion(cargoRun.text);
    }
  }

  const toolchain: ToolchainInfo = {
    kind: 'rust',
    version: rustc?.release ?? declaredChannel,
    source: declaredChannel || envOverride || directoryOverride ? 'override' : 'path',
    host: rustc?.host,
    detail: {
      cargo: cargo?.version ?? 'unavailable',
      llvm: rustc?.llvm ?? '',
      commitHash: rustc?.commitHash ?? '',
      commitDate: rustc?.commitDate ?? '',
      rustup: rustup.available ? 'yes' : 'no',
      rustupHome: home,
      defaultToolchain: rustup.defaultToolchain ?? '',
      installedToolchains: installed.join(', '),
      toolchainFile: toolchainFile?.path ?? '',
      toolchainFileChannel: declaredChannel ?? '',
      toolchainFileComponents: toolchainFile?.components.join(', ') ?? '',
      toolchainFileTargets: toolchainFile?.targets.join(', ') ?? '',
      directoryOverride: directoryOverride
        ? `${directoryOverride.directory} -> ${directoryOverride.toolchain}`
        : '',
      effectiveChannel: effectiveChannel ?? '',
      detection: 'filesystem',
    },
  };

  return {
    toolchain,
    rustc,
    cargo,
    rustup,
    toolchainFile,
    effectiveChannel,
    warnings,
    errors,
    commands,
  };
}

/** True when the report proves a usable toolchain, so cargo may be spawned. */
export function toolchainUsable(report: ToolchainReport): boolean {
  return report.errors.length === 0 && report.rustc !== undefined;
}

/**
 * Read-only proof that the workspace resolves the same way the lockfile says.
 *
 * `--locked` turns "the lockfile is out of date" into an error instead of
 * silently rewriting Cargo.lock, which is the difference between reporting
 * drift and hiding it.
 */
export function lockfileCheckCommand(ctx: AdapterContext): CommandPreview {
  return metadataCommand(ctx, { locked: true });
}
