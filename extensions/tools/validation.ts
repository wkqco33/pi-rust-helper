import { join } from 'node:path';
import { Type } from 'typebox';
import {
  buildCompletionEvidence,
  runCommand,
  summarizeValidation,
  type ValidationStep,
} from 'pi-helper-core';
import type { Diagnostic } from '../../src/core/result.ts';
import { failure, result, warn } from '../../src/core/result.ts';
import { rustAdapter } from '../../src/rust/adapter.ts';
import {
  cargoFmtCheckCommand,
  cargoClippyCommand,
  featureArgs,
  metadataCommand,
  type FeatureSelection,
} from '../../src/rust/commands.ts';
import { diagnoseRustFailure } from '../../src/rust/failure.ts';
import { readProjectModel, type RustProjectModel } from '../../src/rust/metadata.ts';
import { parseTestOutput } from '../../src/rust/output.ts';
import { inspectToolchain, toolchainUsable } from '../../src/rust/toolchain.ts';
import { messageOf, readTextIfExists, resolveProject, text, type Pi } from './shared.ts';

const LABELS = {
  lock: 'cargo metadata --locked',
  preparation: 'cargo check',
  stale: 'a stale artifact',
};

function stepFrom(run: { code: number | null; timedOut: boolean }): ValidationStep {
  return { executed: true, ok: run.code === 0 && !run.timedOut, exitCode: run.code };
}

function skippedStep(name: string, reason: string): ValidationStep {
  return { name, executed: false, ok: false, exitCode: null, skippedReason: reason };
}

/** Quality gates the project declares, so linting never appears as its own tool. */
export async function declaredQualityGates(
  root: string,
  model: RustProjectModel,
): Promise<{ clippy: boolean; fmt: boolean }> {
  const clippyToml =
    (await readTextIfExists(join(root, 'clippy.toml'))) !== undefined ||
    (await readTextIfExists(join(root, '.clippy.toml'))) !== undefined;
  const fmtToml =
    (await readTextIfExists(join(root, 'rustfmt.toml'))) !== undefined ||
    (await readTextIfExists(join(root, '.rustfmt.toml'))) !== undefined;

  let clippyLints = false;
  for (const manifest of [
    join(root, 'Cargo.toml'),
    ...model.members.map((entry) => entry.manifest),
  ]) {
    const manifestText = await readTextIfExists(manifest);
    if (!manifestText) continue;
    if (
      /\[(?:workspace\.)?lints\.clippy\]/.test(manifestText) ||
      /\[(?:workspace\.)?lints\][\s\S]*?^clippy\s*=/m.test(manifestText)
    ) {
      clippyLints = true;
      break;
    }
  }
  return { clippy: clippyToml || clippyLints, fmt: fmtToml };
}

export function registerValidationTools(pi: Pi): void {
  pi.registerTool({
    name: 'rust_validation_bundle',
    label: 'Rust Validation Bundle',
    description:
      'Preview or run one evidence-oriented sequence: cargo metadata --locked, cargo check, cargo test, execution-scope verification, and declared quality gates. Execution is opt-in.',
    promptSnippet: 'Run the Rust build and test validation bundle',
    promptGuidelines: [
      'Use rust_validation_bundle with execute=false first; a preview is never a passing validation.',
      'The bundle rebuilds before testing and treats a workspace member that produced no test binary, or a zero-test run, as a failed gate rather than a pass.',
    ],
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String())),
      features: Type.Optional(
        Type.Union([Type.Literal('default'), Type.Literal('all'), Type.Literal('none')]),
      ),
      quality: Type.Optional(
        Type.Boolean({
          description:
            'Run declared quality gates (cargo clippy when configured, cargo fmt --check when rustfmt.toml exists). Defaults to true.',
        }),
      ),
      execute: Type.Optional(Type.Boolean()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const located = await resolveProject(ctx.cwd, params.path);
        if (!located.root || located.error) {
          return text(
            failure(
              ctx.cwd,
              started,
              located.error ?? 'No Rust project was found.',
              'PROJECT_NOT_FOUND',
            ),
          );
        }
        const scoped = { cwd: ctx.cwd, projectRoot: located.root, signal };

        const toolchain = await inspectToolchain(scoped);
        if (!toolchainUsable(toolchain)) {
          return text(
            failure(
              ctx.cwd,
              started,
              toolchain.errors[0]?.message ?? 'No usable Rust toolchain.',
              toolchain.errors[0]?.code ?? 'RUST_NOT_INSTALLED',
              {
                warnings: toolchain.warnings,
                errors: toolchain.errors,
                toolchain: toolchain.toolchain,
                projectRoot: located.root,
              },
            ),
          );
        }
        const read = await readProjectModel(scoped);
        if (!read.ok) {
          return text(
            failure(ctx.cwd, started, read.message, read.code, { projectRoot: located.root }),
          );
        }
        const model = read.model;
        const features = params.features as FeatureSelection | undefined;
        const runQuality = params.quality ?? true;
        const gates = runQuality
          ? await declaredQualityGates(located.root, model)
          : { clippy: false, fmt: false };

        const expected = params.targets?.length
          ? model.members.filter((entry) => params.targets?.includes(entry.name))
          : model.members.filter((entry) => entry.targets.some((target) => target.test));
        const doctestCapable = expected.filter((entry) =>
          entry.targets.some((target) => target.doctest),
        );

        const lockCommand = metadataCommand(scoped, { locked: true });
        const checkCommand = rustAdapter.checkCommand(
          {
            targets: params.targets,
            allTargets: true,
            extraArgs: features ? featureArgs(features) : [],
          },
          scoped,
        );
        const testCommand = rustAdapter.testCommand(
          { targets: params.targets, extraArgs: features ? featureArgs(features) : [] },
          scoped,
        );
        const qualityPlan: { name: string; command: ReturnType<typeof cargoClippyCommand> }[] = [
          ...(gates.clippy
            ? [
                {
                  name: 'clippy',
                  command: cargoClippyCommand(
                    { targets: params.targets, allTargets: true },
                    scoped,
                  ),
                },
              ]
            : []),
          ...(gates.fmt ? [{ name: 'rustfmt', command: cargoFmtCheckCommand(scoped) }] : []),
        ];
        const qualityCommands = qualityPlan.map((entry) => entry.command);
        const timeoutMs = (params.timeoutSeconds ?? 1800) * 1000;

        if (!params.execute) {
          const summary = summarizeValidation({
            lock: { executed: false, ok: true },
            preparation: { executed: false, ok: true },
            test: { executed: false, ok: true },
            quality: [],
            conformance: 'unverifiable',
            stale: false,
            preview: true,
            labels: LABELS,
          });
          return text(
            result(ctx.cwd, started, {
              ok: false,
              summary: summary.reason,
              data: {
                executed: false,
                qualityGates: gates,
                steps: [lockCommand, checkCommand, testCommand, ...qualityCommands],
                expectedMembers: expected.map((entry) => entry.name),
              },
              evidence: [
                {
                  kind: 'validation_preview',
                  steps: [lockCommand, checkCommand, testCommand, ...qualityCommands].map(
                    (entry) => `${entry.executable} ${entry.args.join(' ')}`,
                  ),
                },
              ],
              warnings: [...model.warnings, warn('PREVIEW_ONLY', summary.reason)],
              errors: [],
              suggestions: [
                {
                  message:
                    'Set execute=true to run the sequence. This compiles the workspace and runs the tests.',
                  confidence: 'high' as const,
                },
              ],
              commands: [lockCommand, checkCommand, testCommand, ...qualityCommands],
              toolchain: toolchain.toolchain,
              projectRoot: located.root,
            }),
          );
        }

        const lockRun = await runCommand(lockCommand.executable, lockCommand.args, {
          cwd: located.root,
          signal,
          timeoutMs,
          maxBytes: 512 * 1024,
        });
        const lockOutput = `${lockRun.stdout}\n${lockRun.stderr}`;
        const lockStep = stepFrom(lockRun);
        const conformance: 'consistent' | 'drifted' | 'unverifiable' =
          lockRun.code === 0
            ? 'consistent'
            : /needs to be updated|cannot (?:update|create) the lock file|--locked/i.test(
                  lockOutput,
                )
              ? 'drifted'
              : 'unverifiable';

        // A drifted lockfile is not repaired by the gate: cargo would rewrite
        // Cargo.lock during check/test, which hides the drift instead of reporting it.
        const checkRun =
          lockStep.ok && !lockRun.timedOut
            ? await runCommand(checkCommand.executable, checkCommand.args, {
                cwd: located.root,
                signal,
                timeoutMs,
                maxBytes: 4 * 1024 * 1024,
              })
            : undefined;
        const checkStep = checkRun
          ? stepFrom(checkRun)
          : skippedStep(
              'cargo check',
              'The lockfile check did not pass, so cargo was not allowed to rewrite Cargo.lock.',
            );
        const checkDiagnosis =
          checkRun && checkRun.code !== 0
            ? diagnoseRustFailure(`${checkRun.stdout}\n${checkRun.stderr}`, {
                projectRoot: located.root,
              })
            : undefined;

        const testRun =
          checkStep.ok && !checkRun?.timedOut
            ? await runCommand(testCommand.executable, testCommand.args, {
                cwd: located.root,
                signal,
                timeoutMs,
                maxBytes: 8 * 1024 * 1024,
              })
            : undefined;
        const report = testRun ? parseTestOutput(testRun.stdout, testRun.stderr) : undefined;
        const tested = new Set(report?.testedPackages ?? []);
        const missing = expected
          .filter((entry) => !tested.has(entry.name))
          .map((entry) => entry.name);

        const testStep: ValidationStep = testRun
          ? {
              ...stepFrom(testRun),
              failures: report?.counts.failed ?? 0,
              noTestsRan: report?.noTestsRan ?? false,
              ok:
                testRun.code === 0 &&
                !testRun.timedOut &&
                report !== undefined &&
                !report.noTestsRan &&
                missing.length === 0,
            }
          : skippedStep(
              'cargo test',
              checkRun
                ? 'cargo check did not pass, so cargo test was not run.'
                : 'The lockfile check did not pass, so cargo test was not run.',
            );

        const qualitySteps: ValidationStep[] = [];
        for (const entry of qualityPlan) {
          if (!testStep.ok) {
            qualitySteps.push(
              skippedStep(entry.name, 'Tests did not pass, so the quality gate was skipped.'),
            );
            continue;
          }
          const run = await runCommand(entry.command.executable, entry.command.args, {
            cwd: located.root,
            signal,
            timeoutMs,
            maxBytes: 4 * 1024 * 1024,
          });
          qualitySteps.push({ name: entry.name, ...stepFrom(run) });
        }

        const summary = summarizeValidation({
          lock: lockStep,
          preparation: checkStep,
          test: testStep,
          quality: qualitySteps,
          conformance,
          stale: false,
          labels: LABELS,
        });

        const warnings: Diagnostic[] = [...model.warnings];
        if (missing.length > 0) {
          warnings.push(
            warn(
              'SCOPE_INCOMPLETE',
              `${missing.join(', ')} produced no test binary, so the passing run does not cover the workspace.`,
              located.manifest,
            ),
          );
        }
        if (report && !report.incomplete && doctestCapable.length > 0 && !report.includedDocTests) {
          warnings.push(
            warn(
              'DOCTESTS_SKIPPED',
              'No Doc-tests section was produced although members declare documentation tests.',
            ),
          );
        }
        if (testRun?.truncated) {
          warnings.push(warn('OUTPUT_TRUNCATED', 'Test output was truncated.'));
        }
        warnings.push(
          ...qualitySteps
            .filter((step) => step.executed && !step.ok)
            .map((step) => warn('QUALITY_CHECK_FAILED', `${step.name ?? 'quality gate'} failed.`)),
        );

        return text(
          result(ctx.cwd, started, {
            ok: summary.ok,
            summary: summary.reason,
            data: {
              executed: true,
              checks: summary.checks,
              lock: { ...lockStep, conformance },
              preparation: { ...checkStep, diagnosis: checkDiagnosis },
              test: {
                ...testStep,
                counts: report?.counts ?? null,
                ranTargets: report?.ranTargets ?? [],
                testedPackages: report?.testedPackages ?? [],
                includedDocTests: report?.includedDocTests ?? false,
                noTestsRan: report?.noTestsRan ?? false,
                missingMembers: missing,
                failures: (report?.failures ?? []).slice(0, 20),
              },
              quality: qualitySteps,
              scope: {
                expectedMembers: expected.map((entry) => entry.name),
                testedPackages: [...tested].sort(),
                missingMembers: missing,
              },
              // Rust has no mtime-based derived artifact: cargo's target/
              // fingerprints are content-based. The scope check above is what
              // takes its place.
              staleArtifacts: {
                applicable: false,
                stale: false,
                reason: 'cargo target/ fingerprints are content-based',
              },
            },
            evidence: [
              {
                kind: 'validation_bundle',
                checks: summary.checks,
                conformance,
                lockExitCode: lockStep.exitCode ?? null,
                checkExitCode: checkStep.exitCode ?? null,
                testExitCode: testStep.exitCode ?? null,
                testCounts: report?.counts ?? null,
                ranTargets: report?.ranTargets ?? [],
                includeDocTests: report?.includedDocTests ?? false,
                missingMembers: missing,
                quality: qualitySteps.map((step) => ({ name: step.name, ok: step.ok })),
                executed: true,
              },
            ],
            warnings,
            errors: summary.ok
              ? []
              : [
                  {
                    code: 'VALIDATION_FAILED',
                    message: summary.reason,
                    severity: 'error' as const,
                  },
                ],
            suggestions: summary.ok
              ? []
              : [
                  {
                    message:
                      'Fix the failing step before reporting completion; a partial run is not evidence.',
                    confidence: 'high' as const,
                  },
                  ...(checkDiagnosis?.suggestions ?? []),
                ],
            commands: [lockCommand, checkCommand, testCommand, ...qualityCommands],
            toolchain: toolchain.toolchain,
            projectRoot: located.root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'rust_completion_evidence',
    label: 'Rust Completion Evidence',
    description:
      'Build a conservative completion report from build and test execution results. Read-only.',
    promptSnippet: 'Create evidence for a Rust completion report',
    promptGuidelines: [
      'Use rust_completion_evidence before claiming Rust work is complete; a partial run is not evidence.',
    ],
    parameters: Type.Object({
      preparationExecuted: Type.Boolean({
        description: 'Whether cargo check / cargo build actually ran.',
      }),
      preparationOk: Type.Boolean(),
      testExecuted: Type.Boolean({ description: 'Whether cargo test actually ran.' }),
      testOk: Type.Boolean(),
      stale: Type.Boolean({ description: 'Whether a stale artifact was detected.' }),
      changedPaths: Type.Array(Type.String(), { maxItems: 500 }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const started = Date.now();
      const evidence = buildCompletionEvidence({
        preparation: {
          name: 'cargo check',
          label: 'cargo check',
          executed: params.preparationExecuted,
          ok: params.preparationOk,
        },
        testExecuted: params.testExecuted,
        testOk: params.testOk,
        stale: params.stale,
        changedPaths: params.changedPaths,
      });
      return text(
        result(ctx.cwd, started, {
          ok: evidence.ok,
          summary: evidence.ok
            ? 'Completion evidence is sufficient for the supplied checks.'
            : 'Completion evidence is incomplete or contains failing checks.',
          data: evidence,
          evidence: evidence.blockers.map((message) => ({ kind: 'completion_blocker', message })),
          warnings: evidence.blockers.map((message) => warn('INCOMPLETE_EVIDENCE', message)),
          errors: evidence.ok
            ? []
            : [
                {
                  code: 'COMPLETION_NOT_PROVEN',
                  message: 'The supplied evidence does not prove completion.',
                  severity: 'error' as const,
                },
              ],
          suggestions: evidence.ok
            ? []
            : [
                {
                  message:
                    'Run rust_validation_bundle and address every blocker before reporting completion.',
                  confidence: 'high' as const,
                },
              ],
        }),
      );
    },
  });
}
