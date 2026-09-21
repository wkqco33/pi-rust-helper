import assert from 'node:assert/strict';
import test from 'node:test';
import { modelFromMetadata, type RustProjectModel } from '../src/rust/metadata.ts';
import {
  RUST_SELECTION_SIGNALS,
  RUST_TDD_SIGNALS,
  cratesForChangedFiles,
  isRunnableTestFile,
  isSourceFile,
  isTestFile,
  listRustTestFiles,
  memberForPath,
  moduleNamesForFile,
  pathTokens,
  rustTestDirectories,
  withDependents,
} from '../src/rust/selection.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'path+file:///ws/crates/app#probe-app@0.1.0';
const CORE = 'path+file:///ws/crates/core#probe-core@0.1.0';

const raw: Parameters<typeof modelFromMetadata>[0] = {
  workspace_root: '/ws',
  workspace_members: [APP, CORE],
  workspace_default_members: [APP],
  packages: [
    {
      id: APP,
      name: 'probe-app',
      version: '0.1.0',
      manifest_path: '/ws/crates/app/Cargo.toml',
      targets: [
        { name: 'probe-app', kind: ['bin'], test: true, src_path: '/ws/crates/app/src/main.rs' },
      ],
      dependencies: [{ name: 'probe-core' }],
      features: {},
    },
    {
      id: CORE,
      name: 'probe-core',
      version: '0.1.0',
      manifest_path: '/ws/crates/core/Cargo.toml',
      targets: [
        { name: 'probe_core', kind: ['lib'], test: true, src_path: '/ws/crates/core/src/lib.rs' },
      ],
      dependencies: [],
      features: {},
    },
  ],
  resolve: {
    nodes: [
      { id: APP, features: [], dependencies: [CORE] },
      { id: CORE, features: [], dependencies: [] },
    ],
  },
};

function workspace(): RustProjectModel {
  return modelFromMetadata(raw, true);
}

test('Rust files are classified as source or test by layout', () => {
  assert.equal(isSourceFile('crates/core/src/lib.rs'), true);
  assert.equal(isSourceFile('Cargo.toml'), true);
  assert.equal(isSourceFile('README.md'), false);
  assert.equal(isTestFile('crates/core/tests/integration.rs'), true);
  assert.equal(isTestFile('crates/core/src/lib.rs'), false);
  assert.equal(isRunnableTestFile('crates/core/tests/integration.rs'), true);
  assert.equal(isRunnableTestFile('crates/core/tests/common/mod.rs'), false);
});

test('module names cover the crate-relative and crate-qualified forms', () => {
  const names = moduleNamesForFile('crates/core/src/foo/bar.rs');
  assert.ok(names.includes('foo::bar'));
  assert.ok(names.includes('crate::foo::bar'));
  assert.ok(names.includes('core::foo::bar'));
  assert.ok(names.includes('bar'));
  assert.deepEqual(moduleNamesForFile('tests/integration.rs'), [
    'integration',
    'crate::integration',
  ]);
});

test('path tokens drop the tokens every Rust path shares', () => {
  assert.deepEqual(pathTokens('crates/core/src/parser.rs'), ['core', 'parser']);
});

test('a changed path maps to the member whose directory contains it', () => {
  const model = workspace();
  assert.equal(memberForPath(model, 'crates/core/src/parser.rs'), 'probe-core');
  assert.equal(memberForPath(model, 'crates/app/src/main.rs'), 'probe-app');
  assert.equal(memberForPath(model, 'docs/readme.md'), undefined);
});

test('reverse dependencies widen the affected crate set', () => {
  const model = workspace();
  assert.deepEqual(withDependents(model, ['probe-core']), ['probe-app', 'probe-core']);
  assert.deepEqual(withDependents(model, ['probe-app']), ['probe-app']);
});

test('changed files produce changed and affected crates', () => {
  const model = workspace();
  const selection = cratesForChangedFiles(model, ['crates/core/src/lib.rs', 'README.md']);
  assert.deepEqual(selection.changedCrates, ['probe-core']);
  assert.deepEqual(selection.affectedCrates, ['probe-app', 'probe-core']);
  assert.deepEqual(selection.unmatched, []);
});

test('a root manifest change affects every member', () => {
  const selection = cratesForChangedFiles(workspace(), ['Cargo.toml']);
  assert.deepEqual(selection.changedCrates, ['probe-app', 'probe-core']);
  assert.deepEqual(selection.unmatched, []);
});

test('test directories are derived from the members', () => {
  assert.deepEqual(rustTestDirectories(workspace()), ['crates/app/tests', 'crates/core/tests']);
});

test('integration-test files are discovered from the test directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rust-select-'));
  try {
    await mkdir(join(root, 'crates', 'core', 'tests'), { recursive: true });
    await writeFile(join(root, 'crates', 'core', 'tests', 'integration.rs'), '#[test] fn x() {}');
    const memberRoot = join(root, 'crates', 'core');
    const model: RustProjectModel = {
      root,
      workspaceRoot: root,
      lockPresent: false,
      toolchain: { kind: 'rust' },
      warnings: [],
      packages: [],
      defaultMembers: ['probe-core'],
      reverseDependencies: {},
      members: [
        {
          id: 'probe-core',
          name: 'probe-core',
          manifest: join(memberRoot, 'Cargo.toml'),
          root: memberRoot,
          member: true,
          defaultMember: true,
          targets: [{ name: 'probe_core', kinds: ['lib'], test: true, doctest: true, srcPath: '' }],
          features: [],
          appliedFeatures: [],
          dependencies: [],
          declared: [],
        },
      ],
    };
    const files = await listRustTestFiles(model);
    assert.deepEqual(files, ['crates/core/tests/integration.rs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the selection signals satisfy the shared contract', () => {
  assert.equal(RUST_SELECTION_SIGNALS.isTestFile('crates/core/tests/a.rs'), true);
  assert.equal(RUST_SELECTION_SIGNALS.isRunnableTestFile('crates/core/tests/a.rs'), true);
  assert.equal(RUST_TDD_SIGNALS.isSourceFile('src/lib.rs'), true);
  assert.ok(RUST_TDD_SIGNALS.prefixTokens.has('tests'));
});
