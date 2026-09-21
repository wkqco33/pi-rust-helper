import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareVersions,
  dependencySummary,
  globToRegExp,
  lockfileDiagnostic,
  looksLikeNetworkFailure,
  modelFromMetadata,
  msrvWarnings,
  tomlSection,
  workspaceMemberGlobs,
  workspaceMemberWarnings,
  type RustProjectModel,
} from '../src/rust/metadata.ts';

const APP = 'path+file:///ws/crates/app#probe-app@0.1.0';
const CORE = 'path+file:///ws/crates/core#probe-core@0.1.0';

const raw: Parameters<typeof modelFromMetadata>[0] = {
  workspace_root: '/ws',
  target_directory: '/ws/target',
  workspace_members: [APP, CORE],
  workspace_default_members: [APP],
  packages: [
    {
      id: APP,
      name: 'probe-app',
      version: '0.1.0',
      manifest_path: '/ws/crates/app/Cargo.toml',
      edition: '2021',
      targets: [
        {
          name: 'probe-app',
          kind: ['bin'],
          test: true,
          doctest: false,
          src_path: '/ws/crates/app/src/main.rs',
        },
      ],
      dependencies: [{ name: 'probe-core' }],
      features: {},
    },
    {
      id: CORE,
      name: 'probe-core',
      version: '0.1.0',
      manifest_path: '/ws/crates/core/Cargo.toml',
      edition: '2021',
      rust_version: '1.99.0',
      targets: [
        {
          name: 'probe_core',
          kind: ['lib'],
          test: true,
          doctest: true,
          src_path: '/ws/crates/core/src/lib.rs',
        },
      ],
      dependencies: [],
      features: { serde: ['dep:serde'] },
    },
  ],
  resolve: {
    nodes: [
      { id: APP, features: [], dependencies: [CORE] },
      { id: CORE, features: ['serde'], dependencies: [] },
    ],
  },
};

function model(overrides: Partial<RustProjectModel> = {}): RustProjectModel {
  return { ...modelFromMetadata(raw, false), ...overrides };
}
test('the model maps members, default-members, and applied features', () => {
  const value = modelFromMetadata(raw, false);
  assert.equal(value.root, '/ws');
  assert.equal(value.targetDirectory, '/ws/target');
  assert.deepEqual(
    value.members.map((entry) => entry.name),
    ['probe-app', 'probe-core'],
  );
  assert.deepEqual(value.defaultMembers, ['probe-app']);
  const core = value.members.find((entry) => entry.name === 'probe-core');
  assert.equal(core?.minimumToolchain, '1.99.0');
  assert.deepEqual(core?.appliedFeatures, ['serde']);
  assert.deepEqual(core?.features, ['serde']);
  assert.equal(core?.targets[0].doctest, true);
  assert.equal(value.lockPresent, false);
});

test('reverse dependencies are derived from the resolved graph', () => {
  const value = modelFromMetadata(raw, false);
  assert.deepEqual(value.reverseDependencies, { 'probe-core': ['probe-app'] });
});

test('MSRV is compared against the active toolchain release', () => {
  const value = modelFromMetadata(raw, true);
  const warnings = msrvWarnings(value, '1.98.1');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'MSRV_UNSATISFIED');
  assert.deepEqual(msrvWarnings(value, '1.99.0'), []);
  assert.deepEqual(msrvWarnings(value, undefined), []);
});

test('a missing lockfile is a warning only when a binary is built', () => {
  assert.equal(lockfileDiagnostic(model({ lockPresent: true })), undefined);
  const withBinary = lockfileDiagnostic(model({ lockPresent: false }));
  assert.equal(withBinary?.code, 'LOCKFILE_MISSING');
  assert.equal(withBinary?.severity, 'warning');

  const libraryOnly = model({
    lockPresent: false,
    members: model().members.filter((entry) => entry.name === 'probe-core'),
  });
  assert.equal(lockfileDiagnostic(libraryOnly)?.severity, 'info');
});

test('a members glob that matches nothing is reported', () => {
  const text = ['[workspace]', 'members = ["crates/*", "tools/*"]'].join('\n');
  const warnings = workspaceMemberWarnings(model(), text);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'WORKSPACE_MEMBER_MISSING');
  assert.match(warnings[0].message, /tools\/\*/);
});

test('a members glob that matches a member is not reported', () => {
  const text = ['[workspace]', 'members = ["crates/*"]'].join('\n');
  assert.deepEqual(workspaceMemberWarnings(model(), text), []);
});

test('TOML section bodies stop at the next table', () => {
  const text = [
    '[package]',
    'name = "x"',
    '',
    '[workspace]',
    'members = ["a"]',
    '',
    '[lints]',
    'clippy = "warn"',
  ].join('\n');
  const section = tomlSection(text, 'workspace');
  assert.match(section ?? '', /members/);
  assert.equal((section ?? '').includes('[lints]'), false);
  assert.deepEqual(workspaceMemberGlobs(text), ['a']);
  assert.equal(tomlSection(text, 'missing'), undefined);
});

test('globs match one path segment per star', () => {
  assert.ok(globToRegExp('crates/*').test('crates/core'));
  assert.equal(globToRegExp('crates/*').test('crates/core/src'), false);
  assert.ok(globToRegExp('plugins/?').test('plugins/a'));
});

test('versions compare by numeric component', () => {
  assert.equal(compareVersions('1.99.0', '1.98.1'), 1);
  assert.equal(compareVersions('1.98.1', '1.98.1'), 0);
  assert.equal(compareVersions('1.98.0', '1.98.1'), -1);
  assert.equal(compareVersions('1.100.0', '1.99.0'), 1);
  assert.equal(compareVersions('1.98.1-nightly', '1.98.1'), 0);
});

test('duplicate versions and dependency sources are summarized', () => {
  const summary = dependencySummary({
    ...raw,
    packages: [
      ...(raw.packages ?? []),
      {
        id: 'a',
        name: 'serde',
        version: '1.0.0',
        manifest_path: '/c/serde',
        source: 'registry+https://crates.io',
      },
      {
        id: 'b',
        name: 'serde',
        version: '2.0.0',
        manifest_path: '/c/serde2',
        source: 'registry+https://crates.io',
      },
      {
        id: 'c',
        name: 'forked',
        version: '0.1.0',
        manifest_path: '/c/forked',
        source: 'git+https://example.com/forked',
      },
    ],
  });
  assert.deepEqual(summary.duplicates, [
    { name: 'serde', versions: ['1.0.0', '2.0.0'], majorConflict: true },
  ]);
  assert.deepEqual(summary.sources, { path: 2, registry: 2, git: 1, other: 0 });
  assert.equal(summary.complete, true);
  assert.equal(dependencySummary({ ...raw, resolve: null }).complete, false);
});

test('offline resolution failures are recognized', () => {
  assert.equal(looksLikeNetworkFailure('error: no matching package named `serde` found'), true);
  assert.equal(looksLikeNetworkFailure("As a reminder, you're using offline mode"), true);
  assert.equal(looksLikeNetworkFailure('error[E0599]: no method named'), false);
});
