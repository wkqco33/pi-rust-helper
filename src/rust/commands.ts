import type {
  AdapterContext,
  CheckCommandInput,
  CommandPreview,
  TestCommandInput,
} from 'pi-helper-core';
import { riskOf } from 'pi-helper-core';
import { CARGO_RISK_RULES, CARGO_SAFE_OVERRIDES } from './risk.ts';

/**
 * Every cargo command the helper runs is built here, as an argument array.
 *
 * Two consequences matter. First, a package name or path can never be
 * interpolated into a shell string. Second, the exact argv is reported in the
 * response, so "tests passed" can always be read next to what actually ran.
 */
const RULES = { patterns: CARGO_RISK_RULES, safeOverrides: CARGO_SAFE_OVERRIDES };

/** Feature unification makes three compilations possible from one manifest. */
export type FeatureSelection = 'default' | 'all' | 'none';

export function featureArgs(features?: FeatureSelection): string[] {
  if (features === 'all') return ['--all-features'];
  if (features === 'none') return ['--no-default-features'];
  return [];
}

function preview(executable: string, args: string[], ctx: AdapterContext): CommandPreview {
  return {
    executable,
    args,
    cwd: ctx.projectRoot ?? ctx.cwd,
    risk: riskOf([executable, ...args], RULES),
  };
}

function targetArgs(targets: string[] | undefined, workspace: boolean | undefined): string[] {
  const requested = (targets ?? []).filter((target) => target.length > 0);
  if (requested.length > 0) return requested.flatMap((target) => ['-p', target]);
  // `workspace: false` reproduces a bare `cargo test`, which only covers
  // `default-members`; it exists so that scope can be reported instead of hidden.
  return workspace === false ? [] : ['--workspace'];
}

/**
 * Authority for the workspace shape. `--offline` is the default because a
 * metadata call that silently reaches the network hides a lockfile problem, and
 * `--no-deps` is the fallback that still works when the registry is unreachable.
 */
export function metadataCommand(
  ctx: AdapterContext,
  options: { noDeps?: boolean; locked?: boolean; offline?: boolean } = {},
): CommandPreview {
  const args = ['metadata', '--format-version', '1'];
  if (options.noDeps) args.push('--no-deps');
  if (options.locked) args.push('--locked');
  if (options.offline !== false) args.push('--offline');
  return preview('cargo', args, ctx);
}

export interface RustTestInput extends TestCommandInput {
  features?: FeatureSelection;
  /** Include every workspace member; `false` reproduces a bare `cargo test`. */
  workspace?: boolean;
}

/**
 * `--workspace` is the default on purpose: a bare `cargo test` only covers
 * `default-members`, which is the false green this helper exists to catch.
 *
 * `--message-format=json` is added to the test run so the emitted
 * `compiler-artifact` records name the packages that produced a test binary.
 * That is what makes `ranTargets` authoritative instead of guessed from the
 * human-readable `Running ...` headers.
 */
export function cargoTestCommand(input: RustTestInput, ctx: AdapterContext): CommandPreview {
  const args = ['test', ...targetArgs(input.targets, input.workspace)];
  if (input.allTargets) args.push('--all-targets');
  // `cargo test` already runs doc tests; only an explicit opt-out needs a flag.
  if (input.docTests === false) args.push('--tests');
  args.push(...featureArgs(input.features));
  args.push('--message-format=json');
  args.push(...(input.extraArgs ?? []));
  return preview('cargo', args, ctx);
}

export interface RustCheckInput extends CheckCommandInput {
  features?: FeatureSelection;
  workspace?: boolean;
}

export function cargoCheckCommand(input: RustCheckInput, ctx: AdapterContext): CommandPreview {
  const args = ['check', ...targetArgs(input.targets, input.workspace)];
  if (input.allTargets) args.push('--all-targets');
  args.push(...featureArgs(input.features));
  args.push('--message-format=json');
  args.push(...(input.extraArgs ?? []));
  return preview('cargo', args, ctx);
}

export interface RustBuildInput {
  targets?: string[];
  features?: FeatureSelection;
  allTargets?: boolean;
  workspace?: boolean;
  extraArgs?: string[];
}

export function cargoBuildCommand(input: RustBuildInput, ctx: AdapterContext): CommandPreview {
  const args = ['build', ...targetArgs(input.targets, input.workspace)];
  if (input.allTargets) args.push('--all-targets');
  args.push(...featureArgs(input.features));
  args.push(...(input.extraArgs ?? []));
  return preview('cargo', args, ctx);
}

/** Declared quality gates only; used when the project configures clippy. */
export function cargoClippyCommand(input: RustCheckInput, ctx: AdapterContext): CommandPreview {
  const args = ['clippy', ...targetArgs(input.targets, input.workspace)];
  if (input.allTargets) args.push('--all-targets');
  args.push(...featureArgs(input.features));
  args.push('--message-format=json');
  args.push(...(input.extraArgs ?? []));
  return preview('cargo', args, ctx);
}

/** Declared quality gate only; used when the project configures rustfmt. */
export function cargoFmtCheckCommand(ctx: AdapterContext): CommandPreview {
  return preview('cargo', ['fmt', '--all', '--check'], ctx);
}
