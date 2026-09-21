import { open, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AdapterContext, Diagnostic, ProjectModel, ProjectPackage } from 'pi-helper-core';
import { isSpawnFailure, note, runCommand, warn } from 'pi-helper-core';
import { metadataCommand } from './commands.ts';

/**
 * The workspace model, taken from `cargo metadata --format-version 1`.
 *
 * `cargo metadata` is the authority for members, `default-members`, editions,
 * MSRV, targets, and the *resolved* feature set, so there is no hand-written
 * manifest scanner and no protocol version to keep in step.
 */

export interface RustTarget {
  name: string;
  kinds: string[];
  test: boolean;
  doctest: boolean;
  srcPath: string;
}

export interface DeclaredDependency {
  /** The dependency as written in Cargo.toml. */
  name: string;
  /** The crate identifier the source must reference (`-` becomes `_`, rename wins). */
  crate: string;
  kind: 'normal' | 'dev' | 'build';
  optional: boolean;
}

export interface RustPackage extends ProjectPackage {
  id: string;
  root: string;
  targets: RustTarget[];
  features: string[];
  /** Features actually unified in for this build, from `resolve.nodes`. */
  appliedFeatures: string[];
  dependencies: string[];
  /** Declared direct dependencies with the crate name the source would use. */
  declared: DeclaredDependency[];
}

export interface RustProjectModel extends ProjectModel {
  workspaceRoot: string;
  targetDirectory?: string;
  lockPresent: boolean;
  packages: RustPackage[];
  members: RustPackage[];
  defaultMembers: string[];
  /** Package name -> packages that depend on it directly. */
  reverseDependencies: Record<string, string[]>;
}

interface RawPackage {
  id: string;
  name: string;
  version?: string;
  manifest_path: string;
  rust_version?: string | null;
  edition?: string | null;
  source?: string | null;
  features?: Record<string, string[]>;
  targets?: {
    name: string;
    kind: string[];
    test?: boolean;
    doctest?: boolean;
    src_path: string;
  }[];
  dependencies?: {
    name: string;
    rename?: string | null;
    kind?: string | null;
    optional?: boolean;
  }[];
}

interface RawMetadata {
  workspace_root: string;
  target_directory?: string;
  workspace_members?: string[];
  workspace_default_members?: string[];
  packages?: RawPackage[];
  resolve?: { nodes?: { id: string; features?: string[]; dependencies?: string[] }[] } | null;
}

export type ModelResult =
  | { ok: true; model: RustProjectModel; raw: RawMetadata }
  | { ok: false; code: string; message: string; output: string };

export function findProjectRoot(start: string): Promise<string | undefined> {
  return findUp(resolve(start), 'Cargo.toml');
}

async function findUp(start: string, fileName: string): Promise<string | undefined> {
  let directory = start;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const entries = await readdir(directory);
      if (entries.includes(fileName)) return directory;
    } catch {
      return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

async function readTextIfExists(path: string, maxBytes = 256 * 1024): Promise<string | undefined> {
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

/** Body of one TOML table, stopping at the next table header. */
export function tomlSection(text: string, name: string): string | undefined {
  const header = new RegExp(`^\\s*\\[${name}\\]\\s*$`, 'm').exec(text);
  if (!header) return undefined;
  const rest = text.slice(header.index + header[0].length);
  const next = rest.search(/^\s*\[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** `members` globs from the root manifest, as written. */
export function workspaceMemberGlobs(text: string): string[] {
  const section = tomlSection(text, 'workspace');
  if (!section) return [];
  const body = section.match(/^\s*members\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  return [...body.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (const character of glob) {
    if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}/?$`);
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^[^0-9]*/, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function modelFromMetadata(raw: RawMetadata, lockPresent: boolean): RustProjectModel {
  const memberIds = new Set(raw.workspace_members ?? []);
  const defaultIds = new Set(raw.workspace_default_members ?? []);
  const applied = new Map((raw.resolve?.nodes ?? []).map((node) => [node.id, node.features ?? []]));

  const members: RustPackage[] = (raw.packages ?? [])
    .filter((entry) => memberIds.has(entry.id))
    .map((entry) => {
      const targets: RustTarget[] = (entry.targets ?? []).map((target) => ({
        name: target.name,
        kinds: target.kind,
        test: target.test === true,
        doctest: target.doctest === true,
        srcPath: target.src_path,
      }));
      const declaredFeatures = Object.keys(entry.features ?? {}).sort();
      const appliedFeatures = [...(applied.get(entry.id) ?? [])].sort();
      const declaredDependencies: DeclaredDependency[] = (entry.dependencies ?? []).map(
        (dependency) => ({
          name: dependency.name,
          crate: (dependency.rename ?? dependency.name).replace(/-/g, '_'),
          kind:
            dependency.kind === 'dev' ? 'dev' : dependency.kind === 'build' ? 'build' : 'normal',
          optional: dependency.optional === true,
        }),
      );
      return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        manifest: entry.manifest_path,
        root: dirname(entry.manifest_path),
        member: true,
        defaultMember: defaultIds.has(entry.id),
        minimumToolchain: entry.rust_version ?? undefined,
        targets,
        features: declaredFeatures,
        appliedFeatures,
        dependencies: declaredDependencies.map((dependency) => dependency.name).sort(),
        declared: declaredDependencies,
        detail: {
          edition: entry.edition ?? '',
          source: entry.source ?? 'path',
          declaredFeatures: declaredFeatures.join(', ') || '(none)',
          appliedFeatures: appliedFeatures.join(', ') || '(none)',
          testTargets: targets
            .filter((target) => target.test)
            .map((target) => target.name)
            .join(', '),
          doctestTargets: targets
            .filter((target) => target.doctest)
            .map((target) => target.name)
            .join(', '),
        },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    root: raw.workspace_root,
    workspaceRoot: raw.workspace_root,
    targetDirectory: raw.target_directory,
    lockPresent,
    toolchain: { kind: 'rust' },
    packages: members,
    members,
    defaultMembers: members.filter((entry) => entry.defaultMember).map((entry) => entry.name),
    reverseDependencies: reverseDependencies(raw),
    warnings: [],
  };
}

/** Direct reverse dependency edges, used to widen a focused test selection. */
export function reverseDependencies(raw: RawMetadata): Record<string, string[]> {
  const nameById = new Map((raw.packages ?? []).map((entry) => [entry.id, entry.name]));
  const reverse: Record<string, string[]> = {};
  for (const node of raw.resolve?.nodes ?? []) {
    const dependent = nameById.get(node.id);
    if (!dependent) continue;
    for (const dependencyId of node.dependencies ?? []) {
      const dependency = nameById.get(dependencyId);
      if (!dependency) continue;
      const list = reverse[dependency] ?? [];
      if (!list.includes(dependent)) list.push(dependent);
      reverse[dependency] = list.sort();
    }
  }
  return reverse;
}

export function msrvWarnings(model: RustProjectModel, installedRelease?: string): Diagnostic[] {
  if (!installedRelease) return [];
  const warnings: Diagnostic[] = [];
  for (const entry of model.members) {
    if (!entry.minimumToolchain) continue;
    if (compareVersions(entry.minimumToolchain, installedRelease) > 0) {
      warnings.push(
        warn(
          'MSRV_UNSATISFIED',
          `${entry.name} declares rust-version ${entry.minimumToolchain}, but the active toolchain is ${installedRelease}.`,
          entry.manifest,
        ),
      );
    }
  }
  return warnings;
}

export function workspaceMemberWarnings(model: RustProjectModel, text: string): Diagnostic[] {
  const globs = workspaceMemberGlobs(text).filter((glob) => /[*?]/.test(glob));
  if (globs.length === 0) return [];
  const directories = model.members.map((entry) =>
    relative(model.root, entry.root).split(sep).join('/'),
  );
  const warnings: Diagnostic[] = [];
  for (const glob of globs) {
    const pattern = globToRegExp(glob);
    if (!directories.some((directory) => pattern.test(directory))) {
      warnings.push(
        warn(
          'WORKSPACE_MEMBER_MISSING',
          `The workspace members glob "${glob}" matched no package, so a crate may be silently outside the workspace.`,
          join(model.root, 'Cargo.toml'),
        ),
      );
    }
  }
  return warnings;
}

/** A lockfile is expected for anything that produces a runnable artifact. */
export function lockfileDiagnostic(model: RustProjectModel): Diagnostic | undefined {
  if (model.lockPresent) return undefined;
  const producesBinary = model.members.some((entry) =>
    entry.targets.some((target) =>
      target.kinds.some((kind) => ['bin', 'cdylib', 'staticlib', 'proc-macro'].includes(kind)),
    ),
  );
  const path = join(model.root, 'Cargo.lock');
  return producesBinary
    ? warn(
        'LOCKFILE_MISSING',
        'No Cargo.lock is committed for a workspace that builds a binary, so builds resolve dependency versions that no one reviewed.',
        path,
      )
    : note(
        'LOCKFILE_MISSING',
        'No Cargo.lock is committed. This is normal for a library, but reproducible builds need one.',
        path,
      );
}

export function looksLikeNetworkFailure(output: string): boolean {
  return /offline mode|no matching package named|failed to (?:download|fetch|get) |registry `|attempting to make an HTTP request|network failure/i.test(
    output,
  );
}

export interface DependencyFinding {
  name: string;
  versions: string[];
  /** True when the versions disagree on the major component. */
  majorConflict: boolean;
}

export interface DependencySummary {
  duplicates: DependencyFinding[];
  sources: { path: number; registry: number; git: number; other: number };
  /** False when resolution was unavailable, so duplicates cannot be complete. */
  complete: boolean;
}

/**
 * Duplicate versions and dependency sources from the resolved graph.
 *
 * A dependency plan needs the resolved graph, so this is reported as incomplete
 * when the model was read with `--no-deps` rather than pretending the list is
 * exhaustive. Unused-dependency detection is deliberately not attempted here:
 * it needs a source scan and is the one part of the plan's dependency tool that
 * is still outstanding.
 */
export function dependencySummary(raw: RawMetadata): DependencySummary {
  const versionsByName = new Map<string, Set<string>>();
  const sources = { path: 0, registry: 0, git: 0, other: 0 };
  for (const entry of raw.packages ?? []) {
    if (entry.version) {
      const versions = versionsByName.get(entry.name) ?? new Set<string>();
      versions.add(entry.version);
      versionsByName.set(entry.name, versions);
    }
    const source = entry.source ?? null;
    if (source === null) sources.path += 1;
    else if (source.startsWith('registry+')) sources.registry += 1;
    else if (source.startsWith('git+')) sources.git += 1;
    else sources.other += 1;
  }
  const duplicates: DependencyFinding[] = [];
  for (const [name, versions] of versionsByName) {
    if (versions.size < 2) continue;
    const sorted = [...versions].sort(compareVersions);
    const majors = new Set(sorted.map((version) => version.split('.')[0]));
    duplicates.push({ name, versions: sorted, majorConflict: majors.size > 1 });
  }
  duplicates.sort((left, right) => left.name.localeCompare(right.name));
  return { duplicates, sources, complete: raw.resolve !== null && raw.resolve !== undefined };
}

export async function readProjectModel(
  ctx: AdapterContext,
  options: { offline?: boolean } = {},
): Promise<ModelResult> {
  const offline = options.offline ?? true;
  const root = ctx.projectRoot ?? (await findProjectRoot(ctx.cwd));
  if (!root) {
    return {
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      message: 'No Cargo.toml was found, so there is no Rust project to inspect.',
      output: '',
    };
  }
  const scoped: AdapterContext = { ...ctx, projectRoot: root };
  const lockText = await readTextIfExists(join(root, 'Cargo.lock'));
  const manifestText = (await readTextIfExists(join(root, 'Cargo.toml'))) ?? '';
  const lockPresent = lockText !== undefined;

  // Reading the model must never rewrite Cargo.lock. When a lockfile exists it
  // is read with `--locked`; when it does not, `--no-deps` describes the
  // workspace without resolving (and so without generating a lockfile).
  const primary = metadataCommand(
    scoped,
    lockPresent ? { locked: true, offline } : { noDeps: true, offline },
  );
  const primaryRun = await runMetadata(primary, scoped);
  if (primaryRun.code === 0) {
    return parseMetadata(primaryRun.stdout, root, lockPresent, manifestText, []);
  }

  const output = `${primaryRun.stdout}\n${primaryRun.stderr}`;
  if (isSpawnFailure(primaryRun)) {
    return {
      ok: false,
      code: 'CARGO_NOT_INSTALLED',
      message: 'cargo is not available on PATH.',
      output,
    };
  }

  const drift = /needs to be updated|cannot (?:update|create) the lock file/i.test(output);
  const network = looksLikeNetworkFailure(output);
  if (drift || network) {
    // `--no-deps` still describes the workspace and, unlike the resolving forms,
    // does not touch Cargo.lock, so drift is reported instead of being repaired.
    const fallback = metadataCommand(scoped, { noDeps: true, offline });
    const secondary = await runMetadata(fallback, scoped);
    if (secondary.code === 0) {
      return parseMetadata(secondary.stdout, root, lockPresent, manifestText, [
        drift
          ? warn(
              'LOCKFILE_DRIFT',
              'Cargo.lock does not describe the current manifests. Run `cargo metadata` or `cargo update` yourself to refresh it; this read did not rewrite it.',
              join(root, 'Cargo.lock'),
            )
          : warn(
              'RESOLVE_REQUIRES_NETWORK',
              'Dependency resolution needs the registry, which --offline cannot reach, so only the workspace members are reported. Run `cargo fetch` once to make offline resolution possible.',
              join(root, 'Cargo.toml'),
            ),
      ]);
    }
    return {
      ok: false,
      code: drift ? 'LOCKFILE_DRIFT' : 'RESOLVE_REQUIRES_NETWORK',
      message: drift
        ? 'Cargo.lock is out of date and cargo was not allowed to rewrite it.'
        : 'Dependency resolution requires the network, so the workspace model cannot be read offline.',
      output,
    };
  }

  return {
    ok: false,
    code: 'METADATA_FAILED',
    message: 'cargo metadata failed, so the workspace model is unavailable.',
    output,
  };
}

async function runMetadata(command: { executable: string; args: string[] }, ctx: AdapterContext) {
  return runCommand(command.executable, command.args, {
    // Run where the command was built for (`projectRoot`), not the session cwd:
    // a project reached through `path` must be the directory cargo reads.
    cwd: ctx.projectRoot ?? ctx.cwd,
    signal: ctx.signal,
    timeoutMs: 120000,
    maxBytes: 4 * 1024 * 1024,
  });
}

function parseMetadata(
  stdout: string,
  root: string,
  lockPresent: boolean,
  manifestText: string,
  extraWarnings: Diagnostic[],
): ModelResult {
  let raw: RawMetadata;
  try {
    raw = JSON.parse(stdout) as RawMetadata;
  } catch {
    return {
      ok: false,
      code: 'METADATA_INVALID',
      message: 'cargo metadata did not return JSON.',
      output: stdout.slice(0, 2000),
    };
  }
  const model = modelFromMetadata(raw, lockPresent);
  model.warnings = [...workspaceMemberWarnings(model, manifestText), ...extraWarnings];
  const lockfile = lockfileDiagnostic(model);
  if (lockfile) model.warnings.push(lockfile);
  if (!raw.resolve) {
    model.warnings.push(
      note(
        'RESOLVE_UNAVAILABLE',
        'The dependency graph was not resolved, so applied features and the full dependency set are unknown.',
        join(root, 'Cargo.toml'),
      ),
    );
  }
  return { ok: true, model, raw };
}
