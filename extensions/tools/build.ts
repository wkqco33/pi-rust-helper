import { Type } from 'typebox';
import { runCommand } from 'pi-helper-core';
import { failure, result, warn } from '../../src/core/result.ts';
import { cargoBuildCommand, type FeatureSelection } from '../../src/rust/commands.ts';
import { diagnoseRustFailure } from '../../src/rust/failure.ts';
import { messageOf, resolveProject, text, type Pi } from './shared.ts';

export function registerBuildTools(pi: Pi): void {
  pi.registerTool({
    name: 'rust_build',
    label: 'Rust Build',
    description:
      'Preview or run cargo build. Classified as a mutating command, so execution needs execute=true and interactive confirmation.',
    promptSnippet: 'Preview or confirm a cargo build',
    promptGuidelines: [
      'Use rust_build with execute=false first to review the exact cargo invocation.',
      'cargo build writes artifacts under target/; execute=true is required and the caller is asked to confirm.',
    ],
    parameters: Type.Object({
      targets: Type.Optional(Type.Array(Type.String(), { description: 'Workspace members (-p).' })),
      allTargets: Type.Optional(Type.Boolean()),
      features: Type.Optional(
        Type.Union([Type.Literal('default'), Type.Literal('all'), Type.Literal('none')]),
      ),
      workspace: Type.Optional(Type.Boolean()),
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
        const command = cargoBuildCommand(
          {
            targets: params.targets,
            allTargets: params.allTargets,
            workspace: params.workspace,
            features: params.features as FeatureSelection | undefined,
          },
          { cwd: ctx.cwd, projectRoot: located.root, signal },
        );

        if (!params.execute) {
          return text(
            result(ctx.cwd, started, {
              ok: false,
              summary: `cargo build preview generated (risk: ${command.risk ?? 'unknown'}); nothing was executed.`,
              data: { executed: false, command },
              evidence: [{ kind: 'command_preview', ...command }],
              warnings: [
                warn(
                  'PREVIEW_ONLY',
                  `cargo build was not executed, so nothing was built (risk: ${command.risk ?? 'unknown'}).`,
                ),
              ],
              errors: [],
              suggestions: [
                {
                  message: 'Set execute=true to build; cargo writes artifacts under target/.',
                  confidence: 'high' as const,
                },
              ],
              commands: [command],
              projectRoot: located.root,
            }),
          );
        }

        const confirmed = await ctx.ui.confirm(
          'Run cargo build',
          `${command.executable} ${command.args.join(' ')}`,
        );
        if (!confirmed) {
          return text(
            result(ctx.cwd, started, {
              ok: false,
              summary: 'cargo build was cancelled or requires interactive confirmation.',
              data: { executed: false, command },
              evidence: [{ kind: 'command_preview', ...command }],
              warnings: [
                warn(
                  'BUILD_NOT_CONFIRMED',
                  'cargo build mutates target/, so it runs only after interactive confirmation.',
                ),
              ],
              errors: [],
              suggestions: [
                {
                  message: 'Re-run and confirm the prompt to build.',
                  confidence: 'medium' as const,
                },
              ],
              commands: [command],
              projectRoot: located.root,
            }),
          );
        }

        const run = await runCommand(command.executable, command.args, {
          cwd: ctx.cwd,
          signal,
          timeoutMs: (params.timeoutSeconds ?? 1800) * 1000,
          maxBytes: 4 * 1024 * 1024,
        });
        const combined = `${run.stdout}\n${run.stderr}`;
        const diagnosis =
          run.code === 0 ? undefined : diagnoseRustFailure(combined, { projectRoot: located.root });
        const ok = run.code === 0 && !run.timedOut;

        return text(
          result(ctx.cwd, started, {
            ok,
            summary: run.timedOut
              ? 'cargo build exceeded the time limit and was terminated.'
              : ok
                ? 'cargo build completed.'
                : `cargo build failed: ${diagnosis?.summary ?? 'see the captured output.'}`,
            data: {
              executed: true,
              exitCode: run.code,
              timedOut: run.timedOut,
              truncated: run.truncated,
              risk: command.risk,
              stdoutTail: run.stdout.slice(-4000),
              stderrTail: run.stderr.slice(-4000),
              diagnosis,
            },
            evidence: [
              {
                kind: 'cargo_build',
                exitCode: run.code,
                timedOut: run.timedOut,
                risk: command.risk ?? null,
                executed: true,
              },
            ],
            warnings: run.truncated
              ? [warn('OUTPUT_TRUNCATED', 'Build output was truncated; only the tail is reported.')]
              : [],
            errors: ok
              ? []
              : [
                  {
                    code: run.timedOut ? 'BUILD_TIMEOUT' : 'BUILD_FAILED',
                    message:
                      diagnosis?.summary ??
                      run.stderr.trim().slice(0, 500) ??
                      `cargo build exited with code ${run.code ?? 'unknown'}.`,
                    severity: 'error' as const,
                  },
                ],
            suggestions: diagnosis?.suggestions ?? [],
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
}
