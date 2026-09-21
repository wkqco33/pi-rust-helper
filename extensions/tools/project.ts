import { Type } from 'typebox';
import type { Diagnostic } from '../../src/core/result.ts';
import { failure, note, result, warn } from '../../src/core/result.ts';
import { diagnoseRustFailure } from '../../src/rust/failure.ts';
import { dependencySummary, msrvWarnings, readProjectModel } from '../../src/rust/metadata.ts';
import { inspectToolchain } from '../../src/rust/toolchain.ts';
import { messageOf, resolveProject, text, type Pi } from './shared.ts';

export function registerProjectTools(pi: Pi): void {
  pi.registerTool({
    name: 'rust_project_inspect',
    label: 'Rust Project Inspect',
    description:
      'Read the cargo workspace model (members, default-members, editions, MSRV, targets, applied features) via cargo metadata --offline, and report consistency problems. Read-only.',
    promptSnippet: 'Inspect a Rust workspace manifest and its members',
    promptGuidelines: [
      'Use rust_project_inspect before editing Cargo.toml or when the workspace membership or MSRV is unclear.',
      'default-members only covers part of the workspace; rust_project_inspect lists which members a bare cargo command would miss.',
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
        if (!located.root || located.error) {
          return text(
            failure(
              ctx.cwd,
              started,
              located.error ??
                'No Rust project root was found. Pass the workspace directory or a Cargo.toml path.',
              'PROJECT_NOT_FOUND',
            ),
          );
        }
        const adapterCtx = { cwd: ctx.cwd, projectRoot: located.root, signal };
        const toolchain = await inspectToolchain(adapterCtx);
        const notInstalled = toolchain.errors.find(
          (error) => error.code === 'TOOLCHAIN_NOT_INSTALLED',
        );
        if (notInstalled) {
          return text(
            failure(
              ctx.cwd,
              started,
              notInstalled.message,
              notInstalled.code ?? 'TOOLCHAIN_NOT_INSTALLED',
              {
                warnings: toolchain.warnings,
                suggestions: [
                  {
                    message:
                      `Install the declared toolchain (rustup toolchain install ${toolchain.toolchainFile?.channel ?? ''}) before reading the workspace, because cargo metadata would trigger the download.`.trim(),
                    confidence: 'high',
                    command: toolchain.toolchainFile?.channel
                      ? `rustup toolchain install ${toolchain.toolchainFile.channel}`
                      : undefined,
                  },
                ],
                commands: toolchain.commands,
              },
            ),
          );
        }

        const read = await readProjectModel(adapterCtx);
        if (!read.ok) {
          const diagnosis = diagnoseRustFailure(read.output, { projectRoot: located.root });
          return text(
            failure(ctx.cwd, started, read.message, read.code, {
              data: { output: read.output.slice(-4000), diagnosis },
              evidence: [{ kind: 'cargo_metadata_failure', code: read.code }],
              suggestions: diagnosis.suggestions,
              toolchain: toolchain.toolchain,
              projectRoot: located.root,
            }),
          );
        }

        const model = read.model;
        const dependencies = dependencySummary(read.raw);
        const warnings: Diagnostic[] = [
          ...model.warnings,
          ...msrvWarnings(model, toolchain.rustc?.release),
          ...toolchain.warnings,
          ...dependencies.duplicates.map((entry) =>
            entry.majorConflict
              ? warn(
                  'DUPLICATE_DEPENDENCY_MAJOR',
                  `${entry.name} resolves to ${entry.versions.join(', ')} across the workspace; the differing major versions can cause trait or type mismatch errors.`,
                )
              : note(
                  'DUPLICATE_DEPENDENCY_VERSION',
                  `${entry.name} resolves to ${entry.versions.join(', ')}; compatible duplicates are normal, but they inflate the build.`,
                ),
          ),
          ...(dependencies.sources.git > 0
            ? [
                note(
                  'GIT_DEPENDENCY',
                  `${dependencies.sources.git} git dependency(ies) are pinned by revision, so offline builds and reproducibility depend on the checkout.`,
                ),
              ]
            : []),
          ...(dependencies.complete
            ? []
            : [
                note(
                  'DEPENDENCY_GRAPH_INCOMPLETE',
                  'The dependency graph was not resolved, so duplicate versions and source kinds are not exhaustive.',
                ),
              ]),
        ];
        const actionable = warnings.filter((warning) => warning.severity !== 'info');

        const outsideDefaultMembers = model.members
          .filter((entry) => !entry.defaultMember)
          .map((entry) => entry.name);

        const summary =
          `${model.members.length} workspace member(s) · ` +
          `${model.defaultMembers.length} default member(s) · ` +
          `${model.lockPresent ? 'Cargo.lock present' : 'no Cargo.lock'} · ` +
          `${model.members.reduce((total, entry) => total + entry.appliedFeatures.length, 0)} applied feature(s)`;

        const suggestions = actionable
          .filter((warning) => warning.code === 'MSRV_UNSATISFIED')
          .map((warning) => ({
            message: warning.message,
            confidence: 'high' as const,
            command: warning.message.includes('rust-version')
              ? `rustup toolchain install ${model.members.find((entry) => warning.message.includes(entry.name))?.minimumToolchain ?? ''}`.trim()
              : undefined,
          }));

        return text(
          result(ctx.cwd, started, {
            ok: actionable.length === 0,
            summary,
            data: {
              root: model.root,
              targetDirectory: model.targetDirectory ?? null,
              lockPresent: model.lockPresent,
              defaultMembers: model.defaultMembers,
              membersOutsideDefault: outsideDefaultMembers,
              packages: model.members.map((entry) => ({
                name: entry.name,
                version: entry.version,
                manifest: entry.manifest,
                defaultMember: entry.defaultMember ?? false,
                minimumToolchain: entry.minimumToolchain ?? null,
                edition: entry.detail?.edition ?? null,
                declaredFeatures: entry.features,
                appliedFeatures: entry.appliedFeatures,
                targets: entry.targets,
                dependencies: entry.dependencies,
              })),
              reverseDependencies: model.reverseDependencies,
              dependencies,
            },
            evidence: [
              {
                kind: 'workspace_model',
                root: model.root,
                members: model.members.map((entry) => entry.name),
                defaultMembers: model.defaultMembers,
                membersOutsideDefault: outsideDefaultMembers,
                lockPresent: model.lockPresent,
                source: 'cargo metadata --format-version 1 --offline',
              },
              ...(outsideDefaultMembers.length > 0
                ? [
                    {
                      kind: 'default_members_gap',
                      members: outsideDefaultMembers,
                    },
                  ]
                : []),
            ],
            warnings,
            errors: [],
            suggestions,
            toolchain: toolchain.toolchain,
            projectRoot: model.root,
          }),
        );
      } catch (error) {
        return text(failure(ctx.cwd, started, messageOf(error), 'INTERNAL_ERROR'));
      }
    },
  });
}
