import { Type } from 'typebox';
import { checkTdd, runCommand, selectTests, type Diagnostic } from 'pi-helper-core';
import { failure, note, result, warn } from '../../src/core/result.ts';
import { rustAdapter } from '../../src/rust/adapter.ts';
import { featureArgs, type FeatureSelection } from '../../src/rust/commands.ts';
import {
  diagnoseRustFailure,
  parseCompilerDiagnostics,
  type RustDiagnostic,
} from '../../src/rust/failure.ts';
import { readProjectModel, type RustProjectModel } from '../../src/rust/metadata.ts';
import { parseTestOutput, type RustTestReport } from '../../src/rust/output.ts';
import {
  RUST_SELECTION_SIGNALS,
  RUST_TDD_SIGNALS,
  cratesForChangedFiles,
  listRustTestFiles,
} from '../../src/rust/selection.ts';
import {
  changedPathsFromGit,
  messageOf,
  resolveProject,
  text,
  type Ctx,
  type Pi,
} from './shared.ts';

const RUST_TEST_PARAMETERS = {
  targets: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Workspace members to test (-p <crate>). Defaults to the whole workspace.',
    }),
  ),
  allTargets: Type.Optional(
    Type.Boolean({ description: 'Test benches and examples too (--all-targets).' }),
  ),
  docTests: Type.Optional(
    Type.Boolean({
      description:
        'Include documentation tests. cargo test already does; set false to skip them (--tests).',
    }),
  ),
  features: Type.Optional(
    Type.Union([Type.Literal('default'), Type.Literal('all'), Type.Literal('none')], {
      description: 'Feature selection: --all-features or --no-default-features.',
    }),
  ),
  workspace: Type.Optional(
    Type.Boolean({
      description:
        'Cover every workspace member (--workspace). Defaults to true; false reproduces a bare cargo test, which only covers default-members.',
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), { description: 'Extra cargo test arguments, passed verbatim.' }),
  ),
  execute: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  path: Type.Optional(Type.String()),
} as const;

interface ScopedRun {
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

async function runCargo(
  command: { executable: string; args: string[] },
  ctx: Ctx,
  signal: AbortSignal | undefined,
  timeoutSeconds: number,
  maxBytes: number,
): Promise<ScopedRun> {
  const run = await runCommand(command.executable, command.args, {
    cwd: ctx.cwd,
    signal,
    timeoutMs: timeoutSeconds * 1000,
    maxBytes,
  });
  return run;
}

function expectedMembers(
  model: RustProjectModel,
  targets: string[] | undefined,
): typeof model.members {
  if (targets?.length) {
    const wanted = new Set(targets);
    return model.members.filter((entry) => wanted.has(entry.name));
  }
  return model.members.filter((entry) => entry.targets.some((target) => target.test));
}

export function registerTestingTools(pi: Pi): void {
  pi.registerTool({
    name: 'rust_test',
    label: 'Rust Test',
    description:
      'Preview or run cargo test and report what actually ran: ranTargets, tested packages, doc-test inclusion, zero-test runs, and failures. Read-only for sources; it compiles into target/.',
    promptSnippet: 'Preview or run cargo tests and report the execution scope',
    promptGuidelines: [
      'Use rust_test with execute=false first; a preview is never a passing test run.',
      'A root cargo test only covers default-members; rust_test reports which members ran and which were skipped.',
      'A test run that executed zero tests is reported as not proven, not as a pass.',
    ],
    parameters: Type.Object(RUST_TEST_PARAMETERS),
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
        const adapterCtx = { cwd: ctx.cwd, projectRoot: located.root, signal };
        const features = params.features as FeatureSelection | undefined;
        const workspace = params.workspace ?? true;
        const command = rustAdapter.testCommand(
          {
            targets: params.targets,
            allTargets: params.allTargets,
            docTests: params.docTests,
            workspace,
            extraArgs: [...featureArgs(features), ...(params.extraArgs ?? [])],
          },
          adapterCtx,
        );

        const modelRead = await readProjectModel(adapterCtx);
        const model = modelRead.ok ? modelRead.model : undefined;
        const modelWarning: Diagnostic[] = modelRead.ok
          ? modelRead.model.warnings
          : [note('WORKSPACE_UNREADABLE', modelRead.message)];
        const scope: 'workspace' | 'default' | 'targets' = params.targets?.length
          ? 'targets'
          : workspace
            ? 'workspace'
            : 'default';
        // The comparison set is always every testable member, so a narrower run
        // is reported as missing coverage instead of looking complete.
        const expected = model ? expectedMembers(model, params.targets) : [];
        const doctestCapable = expected.filter((entry) =>
          entry.targets.some((target) => target.doctest),
        );

        if (!params.execute) {
          const previewWarnings: Diagnostic[] = [
            ...modelWarning,
            warn('PREVIEW_ONLY', 'No test was executed, so this command preview is not evidence.'),
          ];
          if (model && doctestCapable.length > 0 && params.docTests === false) {
            previewWarnings.push(
              warn(
                'DOCTESTS_SKIPPED',
                `--tests excludes documentation tests, and ${doctestCapable.length} expected member(s) declare them.`,
              ),
            );
          }
          return text(
            result(ctx.cwd, started, {
              ok: false,
              summary: 'cargo test command preview generated; no test was executed.',
              data: {
                executed: false,
                command,
                scope,
                expectedMembers: expected.map((e) => e.name),
              },
              evidence: [{ kind: 'command_preview', ...command }],
              warnings: previewWarnings,
              errors: [],
              suggestions: [
                {
                  message: 'Set execute=true to run the previewed cargo test command.',
                  confidence: 'high' as const,
                },
              ],
              commands: [command],
              projectRoot: located.root,
            }),
          );
        }

        const run = await runCargo(
          command,
          ctx,
          signal,
          params.timeoutSeconds ?? 900,
          8 * 1024 * 1024,
        );
        const report: RustTestReport = {
          ...parseTestOutput(run.stdout, run.stderr),
          exitCode: run.code,
          timedOut: run.timedOut,
          truncated: run.truncated,
        };
        const combined = `${run.stdout}\n${run.stderr}`;
        const tested = new Set(report.testedPackages);
        const missing = expected
          .filter((entry) => !tested.has(entry.name))
          .map((entry) => entry.name);
        const failed = report.counts.failed;

        const warnings: Diagnostic[] = [...modelWarning];
        const errors: Diagnostic[] = [];

        if (missing.length > 0) {
          if (scope === 'default') {
            warnings.push(
              warn(
                'DEFAULT_MEMBERS_ONLY',
                `The run did not cover ${missing.join(', ')}. A bare cargo test only covers default-members; add --workspace (workspace=true) to include them.`,
                located.manifest,
              ),
            );
          } else {
            warnings.push(
              warn(
                'SCOPE_INCOMPLETE',
                `cargo test was asked to cover the whole workspace but ${missing.join(', ')} produced no test binary.`,
                located.manifest,
              ),
            );
          }
        }
        if (!report.incomplete && doctestCapable.length > 0 && !report.includedDocTests) {
          warnings.push(
            warn(
              'DOCTESTS_SKIPPED',
              `No Doc-tests section was produced, and ${doctestCapable.length} expected member(s) declare documentation tests. Confirm whether --tests was intended.`,
            ),
          );
        }
        if (run.truncated) {
          warnings.push(
            warn('OUTPUT_TRUNCATED', 'Test output was truncated; only the tail is reported.'),
          );
        }

        if (run.timedOut) {
          errors.push({
            code: 'TEST_TIMEOUT',
            message: 'cargo test was terminated after exceeding the time limit.',
            severity: 'error',
          });
        }
        if (report.noTestsRan) {
          errors.push({
            code: 'ZERO_TESTS_RUN',
            message:
              'cargo test completed without executing a single test, so the result proves nothing.',
            severity: 'error',
          });
        } else if (failed > 0) {
          errors.push({
            code: 'TESTS_FAILED',
            message: `${failed} test(s) failed.`,
            severity: 'error',
          });
        }
        if (report.incomplete && report.compileErrorCount > 0) {
          errors.push({
            code: 'COMPILE_FAILED',
            message: 'The test build failed before any test could run.',
            severity: 'error',
          });
        } else if (report.incomplete) {
          errors.push({
            code: 'INCOMPLETE_TEST_OUTPUT',
            message: 'No test summary was found, so no test result can be trusted.',
            severity: 'error',
          });
        } else if (run.code !== 0 && errors.length === 0) {
          errors.push({
            code: 'TEST_COMMAND_FAILED',
            message: `cargo test exited with code ${run.code ?? 'unknown'}.`,
            severity: 'error',
          });
        }

        const firstFailure =
          report.compileErrorCount > 0
            ? diagnoseRustFailure(combined, { projectRoot: located.root })
            : undefined;

        const ok =
          run.code === 0 &&
          !run.timedOut &&
          !report.incomplete &&
          !report.noTestsRan &&
          failed === 0 &&
          missing.length === 0;

        const summary = run.timedOut
          ? 'cargo test exceeded the time limit and was terminated.'
          : report.noTestsRan
            ? 'cargo test ran zero tests, so nothing was proven.'
            : report.incomplete
              ? 'cargo test did not reach a summary; inspect the output before trusting any result.'
              : `${report.counts.passed} passed, ${failed} failed, ${report.counts.skipped} ignored across ${report.ranTargets.length} target(s)${missing.length > 0 ? `; ${missing.length} member(s) were not covered` : ''}.`;

        return text(
          result(ctx.cwd, started, {
            ok,
            summary,
            data: {
              executed: true,
              exitCode: run.code,
              timedOut: run.timedOut,
              truncated: run.truncated,
              scope,
              counts: report.counts,
              measured: report.measured,
              filtered: report.filtered,
              summaryLine: report.summaryLine,
              ranTargets: report.ranTargets,
              testedPackages: report.testedPackages,
              includedDocTests: report.includedDocTests,
              noTestsRan: report.noTestsRan,
              missingMembers: missing,
              sections: report.sections.map((section) => ({
                kind: section.kind,
                description: section.description,
                ran: section.ran,
                passed: section.passed,
                failed: section.failed,
                ignored: section.ignored,
              })),
              failures: report.failures.slice(0, 20),
              failureCount: report.failures.length,
              firstFailure,
            },
            evidence: [
              {
                kind: 'cargo_test',
                exitCode: run.code,
                scope,
                ranTargets: report.ranTargets,
                testedPackages: report.testedPackages,
                counts: report.counts,
                includedDocTests: report.includedDocTests,
                noTestsRan: report.noTestsRan,
                missingMembers: missing,
                executed: true,
              },
            ],
            warnings,
            errors,
            suggestions: firstFailure?.suggestions ?? [],
            commands: [command],
            truncated: run.truncated,
            projectRoot: located.root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'rust_test_select',
    label: 'Rust Test Select',
    description:
      'Map changed files to workspace crates through cargo metadata and select the crates to retest, including reverse dependencies. Read-only.',
    promptSnippet: 'Select focused Rust crates to test from changed files',
    promptGuidelines: [
      'Use rust_test_select after changing Rust source to narrow cargo test to the affected crates instead of the whole workspace.',
      'Rust has no per-file test targets; the selection is a set of crates, so a "narrowed" run is reported in crates, not files.',
    ],
    parameters: Type.Object({
      changedPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      testFiles: Type.Optional(Type.Array(Type.String(), { maxItems: 1000 })),
      features: Type.Optional(
        Type.Union([Type.Literal('default'), Type.Literal('all'), Type.Literal('none')]),
      ),
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
        const adapterCtx = { cwd: ctx.cwd, projectRoot: located.root, signal };
        const read = await readProjectModel(adapterCtx);
        if (!read.ok) {
          return text(
            failure(ctx.cwd, started, read.message, read.code, { projectRoot: located.root }),
          );
        }
        const model = read.model;

        let changed = params.changedPaths ?? [];
        let source = 'argument';
        if (changed.length === 0) {
          const discovered = await changedPathsFromGit(ctx.cwd, signal);
          changed = discovered.paths;
          source = discovered.source;
        }

        const crates = cratesForChangedFiles(model, changed);
        const testFiles = params.testFiles ?? (await listRustTestFiles(model));
        const fileSelection = selectTests(changed, testFiles, RUST_SELECTION_SIGNALS);
        const narrowed = crates.affectedCrates.length < model.members.length;
        const features = params.features as FeatureSelection | undefined;
        const command =
          crates.affectedCrates.length > 0
            ? rustAdapter.testCommand(
                {
                  targets: crates.affectedCrates,
                  extraArgs: featureArgs(features),
                },
                adapterCtx,
              )
            : undefined;

        const warnings: Diagnostic[] = [];
        if (changed.length === 0) {
          warnings.push(
            warn(
              'NO_CHANGED_PATHS',
              'No changed file was found, so nothing could be selected. Pass changedPaths explicitly when the change is not visible to git.',
            ),
          );
        }
        if (crates.unmatched.length > 0) {
          warnings.push(
            warn(
              'UNMATCHED_CHANGED_PATHS',
              `${crates.unmatched.length} changed file(s) did not map to a workspace member: ${crates.unmatched.slice(0, 5).join(', ')}`,
            ),
          );
        }
        if (crates.changedCrates.length > 0 && !narrowed) {
          warnings.push(
            warn(
              'NO_NARROWING',
              'The affected crates cover every workspace member, so this is the full workspace rather than a focused target.',
            ),
          );
        }
        if (fileSelection.selected.length > 0 && !fileSelection.importEvidenceUsed) {
          warnings.push(
            warn(
              'SELECTION_WITHOUT_IMPORT_EVIDENCE',
              'Integration-test file ranking used path names only; the crate set above is derived from the workspace layout and is the authoritative target.',
            ),
          );
        }

        return text(
          result(ctx.cwd, started, {
            ok: crates.changedCrates.length > 0 || changed.length === 0,
            summary:
              `${crates.changedCrates.length} changed crate(s), ${crates.affectedCrates.length} affected crate(s) ` +
              `from ${changed.length} changed path(s) (${source}).` +
              (crates.affectedCrates.length > 0
                ? narrowed
                  ? ''
                  : ' Every member is affected, so nothing was narrowed.'
                : ' No Rust source change was matched.'),
            data: {
              changedPaths: changed,
              changedSource: source,
              changedCrates: crates.changedCrates,
              affectedCrates: crates.affectedCrates,
              unmatched: crates.unmatched,
              narrowed,
              cargoTestTargets: crates.affectedCrates,
              fileSelection,
              reverseDependencies: model.reverseDependencies,
            },
            evidence: [
              {
                kind: 'crate_selection',
                changedPaths: changed,
                changedCrates: crates.changedCrates,
                affectedCrates: crates.affectedCrates,
                narrowed,
              },
            ],
            warnings,
            errors: [],
            suggestions: command
              ? [
                  {
                    message:
                      'Run cargo test with -p for the affected crates, or use rust_test with these targets.',
                    confidence: 'high' as const,
                    command: `${command.executable} ${command.args.join(' ')}`,
                  },
                ]
              : [],
            commands: command ? [command] : [],
            projectRoot: located.root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'rust_check',
    label: 'Rust Check',
    description:
      'Run cargo check with --message-format=json and summarize structured compiler diagnostics without building final artifacts. Read-only for sources.',
    promptSnippet: 'Run cargo check and summarize compiler diagnostics',
    promptGuidelines: [
      'Use rust_check to get structured compiler diagnostics by error code and first project frame.',
      'Diagnostics whose only frame is a registry or toolchain file are classified as library locations, not project causes.',
    ],
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String())),
      allTargets: Type.Optional(Type.Boolean()),
      features: Type.Optional(
        Type.Union([Type.Literal('default'), Type.Literal('all'), Type.Literal('none')]),
      ),
      workspace: Type.Optional(Type.Boolean()),
      execute: Type.Optional(Type.Boolean()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
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
        const adapterCtx = { cwd: ctx.cwd, projectRoot: located.root, signal };
        const command = rustAdapter.checkCommand(
          {
            targets: params.targets,
            allTargets: params.allTargets,
            workspace: params.workspace,
            extraArgs: featureArgs(params.features as FeatureSelection | undefined),
          },
          adapterCtx,
        );
        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: false,
              summary: 'cargo check command preview generated; nothing was executed.',
              data: { executed: false, command },
              evidence: [{ kind: 'command_preview', ...command }],
              warnings: [
                warn('PREVIEW_ONLY', 'cargo check was not executed, so nothing was proven.'),
              ],
              errors: [],
              suggestions: [
                { message: 'Set execute=true to run cargo check.', confidence: 'high' as const },
              ],
              commands: [command],
              projectRoot: located.root,
            }),
          );
        }

        const run = await runCargo(
          command,
          ctx,
          signal,
          params.timeoutSeconds ?? 600,
          4 * 1024 * 1024,
        );
        const combined = `${run.stdout}\n${run.stderr}`;
        const diagnostics: RustDiagnostic[] = parseCompilerDiagnostics(combined, {
          projectRoot: located.root,
        });
        const errors = diagnostics.filter(
          (entry) => entry.level === 'error' || entry.level === 'error: internal compiler error',
        );
        const warnings = diagnostics.filter((entry) => entry.level === 'warning' && !entry.library);
        const firstFailure =
          errors.length > 0
            ? diagnoseRustFailure(combined, { projectRoot: located.root })
            : undefined;
        const ok = run.code === 0 && errors.length === 0 && !run.timedOut;

        const codes = new Map<string, number>();
        for (const entry of errors) {
          const key = entry.code ?? 'unclassified';
          codes.set(key, (codes.get(key) ?? 0) + 1);
        }

        return text(
          result(ctx.cwd, started, {
            ok,
            summary: run.timedOut
              ? 'cargo check exceeded the time limit and was terminated.'
              : ok
                ? `cargo check passed with ${warnings.length} project warning(s).`
                : `cargo check reported ${errors.length} error(s) and ${warnings.length} project warning(s).`,
            data: {
              executed: true,
              exitCode: run.code,
              timedOut: run.timedOut,
              truncated: run.truncated,
              errorCount: errors.length,
              warningCount: warnings.length,
              errorCodes: Object.fromEntries(codes),
              diagnostics: errors.slice(0, 20),
              firstFailure,
            },
            evidence: [
              {
                kind: 'cargo_check',
                exitCode: run.code,
                errorCount: errors.length,
                warningCount: warnings.length,
                errorCodes: Object.fromEntries(codes),
                executed: true,
              },
            ],
            warnings: warningList(run.truncated),
            errors: ok
              ? []
              : errors.length > 0
                ? [
                    {
                      code: 'COMPILE_ERRORS',
                      message: `${errors.length} compiler error(s) were reported.`,
                      severity: 'error' as const,
                    },
                  ]
                : [
                    {
                      code: run.timedOut ? 'CHECK_TIMEOUT' : 'CHECK_FAILED',
                      message: run.timedOut
                        ? 'cargo check exceeded the time limit.'
                        : `cargo check exited with code ${run.code ?? 'unknown'}.`,
                      severity: 'error' as const,
                    },
                  ],
            suggestions: firstFailure?.suggestions ?? [],
            commands: [command],
            truncated: run.truncated,
            projectRoot: located.root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'rust_failure_diagnose',
    label: 'Rust Failure Diagnose',
    description:
      'Classify the first actionable Rust error from structured cargo/rustc JSON output and point at the first project frame, excluding registry and toolchain frames. Read-only.',
    promptSnippet: 'Diagnose the first actionable Rust failure',
    promptGuidelines: [
      'Use rust_failure_diagnose on bounded cargo/rustc output instead of reading a full compiler report in context.',
      'Frames inside ~/.cargo/registry or the rustup toolchain are library locations; the project frame is the cause.',
    ],
    parameters: Type.Object({
      output: Type.String({ description: 'Bounded stdout/stderr from a failing cargo command.' }),
      path: Type.Optional(
        Type.String({
          description: 'Project directory used to classify project versus library frames.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const started = Date.now();
      try {
        const located = await resolveProject(ctx.cwd, params.path);
        const root = located.root && !located.error ? located.root : undefined;
        const diagnosis = diagnoseRustFailure(params.output, { projectRoot: root });
        const diagnostics = parseCompilerDiagnostics(params.output, { projectRoot: root });
        const libraryFrames = diagnosis.frames.filter((frame) => frame.library).length;

        return text(
          result(ctx.cwd, started, {
            // A diagnostic tool that finds a problem reports `ok: false`: the
            // question it asks is "is this output a real, located failure?".
            ok: false,
            summary: `${diagnosis.kind}: ${diagnosis.summary}`,
            data: {
              ...diagnosis,
              parser: 'auto',
              compilerMessages: diagnostics.length,
              libraryFrameCount: libraryFrames,
              totalFrameCount: diagnosis.frames.length,
            },
            evidence: [
              {
                kind: 'failure_diagnosis',
                failureKind: diagnosis.kind,
                exceptionType: diagnosis.exceptionType ?? null,
                firstUserFrame: diagnosis.firstUserFrame ?? null,
                libraryFrameCount: libraryFrames,
              },
              ...diagnosis.evidence.map((entry) => ({ kind: 'failure_evidence', ...entry })),
            ],
            warnings:
              diagnosis.kind === 'unknown'
                ? [
                    warn(
                      'UNCLASSIFIED_FAILURE',
                      'The output did not match a known rustc or cargo failure pattern.',
                    ),
                  ]
                : [],
            errors:
              diagnosis.kind === 'unknown'
                ? []
                : [
                    {
                      code: 'FAILURE_DIAGNOSED',
                      message: diagnosis.summary,
                      severity: 'error' as const,
                      path: diagnosis.firstUserFrame?.path,
                      line: diagnosis.firstUserFrame?.line,
                    },
                  ],
            suggestions: diagnosis.suggestions,
            projectRoot: root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });

  pi.registerTool({
    name: 'rust_tdd_checkpoint',
    label: 'Rust TDD Checkpoint',
    description:
      'Check whether production Rust changes have a related test change before implementation is considered complete. Read-only.',
    promptSnippet: 'Check the Rust TDD checkpoint for changed files',
    promptGuidelines: [
      'Use rust_tdd_checkpoint before reporting Rust implementation work as complete.',
    ],
    parameters: Type.Object({
      changedPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      testChangedPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        let changed = params.changedPaths ?? [];
        let source = 'argument';
        if (changed.length === 0) {
          const discovered = await changedPathsFromGit(ctx.cwd, signal);
          changed = discovered.paths;
          source = discovered.source;
        }
        const checkpoint = checkTdd(changed, params.testChangedPaths ?? [], RUST_TDD_SIGNALS);
        return text(
          result(ctx.cwd, started, {
            ok: checkpoint.ok,
            summary: checkpoint.ok
              ? `TDD checkpoint passed across ${changed.length} changed path(s) from ${source}.`
              : 'TDD checkpoint found production changes without a related test change.',
            data: { ...checkpoint, changedPaths: changed, changedSource: source },
            evidence: [
              ...checkpoint.reasons.map((message) => ({ kind: 'tdd_blocker', message })),
              ...checkpoint.associations.map((entry) => ({
                kind: 'tdd_association',
                source: entry.source,
                test: entry.test,
                sharedTokens: entry.sharedTokens,
                strength: entry.strength,
              })),
            ],
            warnings: checkpoint.reasons.map((message) => warn('TDD_CHECKPOINT', message)),
            errors: [],
            suggestions: checkpoint.ok
              ? []
              : [
                  {
                    message:
                      'Add the smallest focused test for the changed behaviour, or explain why the change needs no test.',
                    confidence: 'high' as const,
                  },
                ],
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}

function warningList(truncated: boolean): Diagnostic[] {
  return truncated ? [warn('OUTPUT_TRUNCATED', 'Command output was truncated.')] : [];
}
