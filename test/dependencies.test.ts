import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cratePattern, findUnusedDependencies } from '../src/rust/dependencies.ts';
import type { DeclaredDependency, RustPackage, RustProjectModel } from '../src/rust/metadata.ts';

function member(root: string, declared: DeclaredDependency[]): RustPackage {
  return {
    id: 'app',
    name: 'app',
    manifest: join(root, 'Cargo.toml'),
    root,
    member: true,
    targets: [],
    features: [],
    appliedFeatures: [],
    dependencies: declared.map((entry) => entry.name),
    declared,
  };
}

function model(root: string, declared: DeclaredDependency[]): RustProjectModel {
  const packages = [member(root, declared)];
  return {
    root,
    workspaceRoot: root,
    lockPresent: true,
    toolchain: { kind: 'rust' },
    packages,
    members: packages,
    defaultMembers: ['app'],
    reverseDependencies: {},
    warnings: [],
  };
}

const dep = (name: string, optional = false): DeclaredDependency => ({
  name,
  crate: name.replace(/-/g, '_'),
  kind: 'normal',
  optional,
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-rust-deps-'));
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

test('crate references match whole identifiers, not substrings', () => {
  assert.ok(cratePattern('serde').test('use serde::Deserialize;'));
  assert.ok(cratePattern('probe_util').test('probe_util::helper();'));
  assert.equal(cratePattern('serde').test('my_serde_helper()'), false);
  assert.equal(cratePattern('serde').test('serde_json::Value'), false);
});

test('a dependency referenced by the source is not reported', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'src', 'lib.rs'), 'use serde::Deserialize;\n');
    const report = await findUnusedDependencies(model(root, [dep('serde')]));
    assert.deepEqual(report.findings, []);
    assert.equal(report.scanned, true);
    assert.equal(report.filesScanned, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dependency with no reference is reported', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'src', 'lib.rs'), 'pub fn value() -> i32 { 1 }\n');
    const report = await findUnusedDependencies(model(root, [dep('serde')]));
    assert.deepEqual(report.findings, [
      { member: 'app', dependency: 'serde', crate: 'serde', kind: 'normal' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('optional dependencies are skipped because a feature gates them', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'src', 'lib.rs'), 'pub fn value() -> i32 { 1 }\n');
    const report = await findUnusedDependencies(model(root, [dep('extras', true)]));
    assert.deepEqual(report.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build output directories are not scanned', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'src', 'lib.rs'), 'pub fn value() -> i32 { 1 }\n');
    await mkdir(join(root, 'target', 'debug'), { recursive: true });
    // A reference that only exists in generated output must not count as usage.
    await writeFile(join(root, 'target', 'debug', 'generated.rs'), 'serde::Value;\n');
    const report = await findUnusedDependencies(model(root, [dep('serde')]));
    assert.equal(report.findings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the byte budget is disclosed instead of returning a clean scan', async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, 'src', 'lib.rs'), 'pub fn value() -> i32 { 1 }\n');
    const report = await findUnusedDependencies(model(root, [dep('serde')]), {
      maxTotalBytes: 1,
    });
    assert.ok(report.incompleteReason);
    assert.match(report.incompleteReason ?? '', /MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
