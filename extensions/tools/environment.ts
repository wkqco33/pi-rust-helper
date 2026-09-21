import { Type } from 'typebox';
import type { Diagnostic } from '../../src/core/result.ts';
import { failure, note, result } from '../../src/core/result.ts';
import { readProjectModel, findProjectRoot } from '../../src/rust/metadata.ts';
import { inspectToolchain, toolchainUsable } from '../../src/rust/toolchain.ts';
import { messageOf, resolveProject, text, type Pi } from './shared.ts';

export function registerEnvironmentTools(pi: Pi): void {
  pi.registerTool({
    name: 'rust_environment',
    label: 'Rust Environment',
    description:
      'Inspect the Rust toolchain that would actually run (rustc -vV, cargo, rustup state, rust-toolchain.toml channel) and the workspace target directory. Read-only.',
    promptSnippet: 'Inspect the current Rust toolchain and workspace',
    promptGuidelines: [
      'Use rust_environment before cargo diagnostics when the toolchain that would run is unknown.',
      'A rust-toolchain.toml naming an uninstalled channel makes rustup download it; rust_environment reports that before any build runs.',
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Project directory or Cargo.toml path. Defaults to the cwd.' }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      try {
        const located = await resolveProject(ctx.cwd, params.path);
        if (located.error) {
          return text(failure(ctx.cwd, started, located.error, 'PROJECT_NOT_FOUND'));
        }
        const adapterCtx = { cwd: ctx.cwd, projectRoot: located.root, signal };
        const report = await inspectToolchain(adapterCtx);
        const usable = toolchainUsable(report);
        const warnings: Diagnostic[] = [...report.warnings];
        const suggestions: {
          message: string;
          confidence: 'high' | 'medium' | 'low';
          command?: string;
        }[] = [];

        let workspace: {
          root: string;
          targetDirectory?: string;
          members: string[];
          defaultMembers: string[];
        } | null = null;

        if (usable && located.root) {
          const model = await readProjectModel(adapterCtx);
          if (model.ok) {
            workspace = {
              root: model.model.root,
              targetDirectory: model.model.targetDirectory,
              members: model.model.members.map((entry) => entry.name),
              defaultMembers: model.model.defaultMembers,
            };
            warnings.push(...model.model.warnings);
          } else {
            warnings.push(note('WORKSPACE_UNREADABLE', model.message));
          }
        }

        const notInstalled = report.errors.some(
          (error) => error.code === 'TOOLCHAIN_NOT_INSTALLED',
        );
        if (notInstalled) {
          const channel = report.toolchainFile?.channel ?? process.env.RUSTUP_TOOLCHAIN ?? '';
          suggestions.push({
            message:
              `Install the declared toolchain before running cargo: rustup toolchain install ${channel}`.trim(),
            confidence: 'high',
            command: channel ? `rustup toolchain install ${channel}` : undefined,
          });
        } else if (!usable) {
          suggestions.push({
            message: 'Install Rust with rustup (https://rustup.rs) and retry.',
            confidence: 'high',
          });
        } else if (report.toolchainFile && !report.rustup.available) {
          suggestions.push({
            message:
              'rust-toolchain.toml is present but rustup is unavailable, so the file does not affect the toolchain that runs.',
            confidence: 'medium',
          });
        }

        const rustc = report.rustc;
        const summary = usable
          ? `rustc ${rustc?.release ?? report.toolchain.version ?? 'unknown'}${rustc ? ` (${rustc.host})` : ''} · cargo ${report.cargo?.version ?? 'unknown'} · ${report.rustup.installed.length} installed toolchain(s)${workspace ? ` · workspace ${workspace.members.length} member(s)` : ''}`
          : (report.errors[0]?.message ?? 'No usable Rust toolchain was found.');

        return text(
          result(ctx.cwd, started, {
            ok: usable,
            summary,
            data: {
              detected: usable,
              rustc: rustc ?? null,
              cargo: report.cargo ?? null,
              rustup: report.rustup,
              toolchainFile: report.toolchainFile ?? null,
              effectiveChannel: report.effectiveChannel ?? null,
              workspace,
            },
            evidence: [
              {
                kind: 'rust_toolchain',
                rustc: rustc?.release ?? null,
                rustcHost: rustc?.host ?? null,
                cargo: report.cargo?.version ?? null,
                rustupInstalled: report.rustup.installed,
                toolchainFile: report.toolchainFile?.path ?? null,
                toolchainFileChannel: report.toolchainFile?.channel ?? null,
                effectiveChannel: report.effectiveChannel ?? null,
                detection: 'filesystem',
              },
              ...(workspace
                ? [
                    {
                      kind: 'workspace_summary',
                      root: workspace.root,
                      targetDirectory: workspace.targetDirectory ?? null,
                      members: workspace.members,
                      defaultMembers: workspace.defaultMembers,
                    },
                  ]
                : []),
            ],
            warnings,
            errors: report.errors,
            suggestions,
            commands: report.commands,
            toolchain: report.toolchain,
            projectRoot: located.root ?? (await findProjectRoot(ctx.cwd)),
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}
