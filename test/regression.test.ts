import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEnvelope,
  errorCodes,
  invokeTool,
  primeLockfile,
  rustAvailable,
  warningCodes,
  withFixture,
} from './helpers/harness.ts';
import type { RustTestReport } from '../src/rust/output.ts';

const hasRust = await rustAvailable();
const rustTest = { skip: hasRust ? false : 'no Rust toolchain available' };
const rustProject = { skip: hasRust ? false : 'no Rust toolchain available' };

interface TestData {
  testedPackages: string[];
  missingMembers: string[];
  includedDocTests: boolean;
  ranTargets: string[];
  noTestsRan: boolean;
  counts: { passed: number; failed: number; skipped: number };
  sections: { kind: string }[];
}

test(
  'a bare cargo test is caught as default-members-only, and --workspace fixes it',
  rustTest,
  async () => {
    await withFixture('basic-workspace', async (directory) => {
      // A bare `cargo test` only covers default-members, which excludes probe-core.
      const narrow = await invokeTool<TestData>(
        'rust_test',
        { workspace: false, execute: true },
        directory,
      );
      assertEnvelope(narrow, 'rust_test(default)');
      assert.equal(narrow.ok, false, 'an incomplete scope must not be reported as a pass');
      assert.ok(warningCodes(narrow).includes('DEFAULT_MEMBERS_ONLY'));
      assert.deepEqual(narrow.data?.missingMembers, ['probe-core']);
      assert.equal(narrow.data?.testedPackages.includes('probe-core'), false);

      // The same fixture with --workspace covers every member and its doctests.
      const full = await invokeTool<TestData>('rust_test', { execute: true }, directory);
      assertEnvelope(full, 'rust_test(workspace)');
      assert.equal(full.ok, true, full.summary);
      assert.deepEqual(full.data?.missingMembers, []);
      assert.deepEqual(full.data?.testedPackages, ['probe-app', 'probe-core']);
      assert.equal(full.data?.includedDocTests, true);
      assert.deepEqual(
        full.data?.sections.map((section) => section.kind),
        ['unittests', 'unittests', 'integration', 'doctests'],
      );
      assert.deepEqual([...(full.data?.ranTargets ?? [])].sort(), [
        'probe-app (probe-app)',
        'probe-core (integration)',
        'probe-core (probe_core)',
      ]);
    });
  },
);

test('--tests is reported as skipping documentation tests', rustTest, async () => {
  await withFixture('basic-workspace', async (directory) => {
    const value = await invokeTool<TestData>(
      'rust_test',
      { execute: true, docTests: false },
      directory,
    );
    assertEnvelope(value, 'rust_test(no-doc)');
    assert.equal(value.data?.includedDocTests, false);
    assert.ok(warningCodes(value).includes('DOCTESTS_SKIPPED'));
  });
});

test('a run that executes zero tests is not proven', rustTest, async () => {
  await withFixture('zero-tests', async (directory) => {
    const value = await invokeTool<TestData>('rust_test', { execute: true }, directory);
    assertEnvelope(value, 'rust_test(zero)');
    assert.equal(value.ok, false);
    assert.equal(value.data?.noTestsRan, true);
    assert.equal(value.data?.counts.passed, 0);
    assert.ok(errorCodes(value).includes('ZERO_TESTS_RUN'));
    assert.ok(
      [...value.warnings, ...value.errors].some((entry) => entry.severity !== 'info'),
      'ok:false must carry an actionable diagnostic',
    );
  });
});

test(
  'a compiler error is diagnosed at the project frame, not a library one',
  rustProject,
  async () => {
    await withFixture('broken', async (directory) => {
      const value = await invokeTool('rust_check', { execute: true }, directory);
      assertEnvelope(value, 'rust_check(broken)');
      assert.equal(value.ok, false);
      assert.ok(errorCodes(value).includes('COMPILE_ERRORS'));
      const data = value.data as {
        errorCodes: Record<string, number>;
        firstFailure?: { exceptionType?: string; firstUserFrame?: { path: string } };
      };
      assert.equal(data.errorCodes.E0599, 1);
      assert.equal(data.firstFailure?.exceptionType, 'E0599');
      assert.equal(data.firstFailure?.firstUserFrame?.path, 'src/lib.rs');
    });
  },
);

test('an MSRV above the installed toolchain is reported', rustProject, async () => {
  await withFixture('msrv', async (directory) => {
    const value = await invokeTool('rust_project_inspect', {}, directory);
    assertEnvelope(value, 'rust_project_inspect(msrv)');
    assert.equal(value.ok, false);
    assert.ok(warningCodes(value).includes('MSRV_UNSATISFIED'));
    const data = value.data as { packages: { name: string; minimumToolchain: string | null }[] };
    assert.equal(data.packages[0].minimumToolchain, '1.99.0');
  });
});

test('the workspace model exposes members a bare command would miss', rustProject, async () => {
  await withFixture('basic-workspace', async (directory) => {
    await primeLockfile(directory);
    const inspect = await invokeTool('rust_project_inspect', {}, directory);
    assertEnvelope(inspect, 'rust_project_inspect');
    assert.equal(inspect.ok, true, inspect.summary);
    const data = inspect.data as { membersOutsideDefault: string[]; defaultMembers: string[] };
    assert.deepEqual(data.defaultMembers, ['probe-app']);
    assert.deepEqual(data.membersOutsideDefault, ['probe-core']);

    const selection = await invokeTool(
      'rust_test_select',
      { changedPaths: ['crates/core/src/lib.rs'] },
      directory,
    );
    assertEnvelope(selection, 'rust_test_select');
    const selected = selection.data as { affectedCrates: string[]; changedCrates: string[] };
    assert.deepEqual(selected.changedCrates, ['probe-core']);
    assert.deepEqual(selected.affectedCrates, ['probe-app', 'probe-core']);
  });
});

test('the validation bundle refuses to pass on a preview', rustProject, async () => {
  await withFixture('basic-workspace', async (directory) => {
    const preview = await invokeTool('rust_validation_bundle', {}, directory);
    assertEnvelope(preview, 'validation_bundle(preview)');
    assert.equal(preview.ok, false);
    assert.ok(warningCodes(preview).includes('PREVIEW_ONLY'));
  });
});

test(
  'the validation bundle passes only after a primed lockfile and a full run',
  rustProject,
  async () => {
    await withFixture('basic-workspace', async (directory) => {
      await primeLockfile(directory);
      const value = await invokeTool('rust_validation_bundle', { execute: true }, directory);
      assertEnvelope(value, 'validation_bundle');
      assert.equal(value.ok, true, value.summary);
      const data = value.data as {
        lock: { conformance: string; ok: boolean };
        test: { ranTargets: string[]; missingMembers: string[]; includedDocTests: boolean };
        staleArtifacts: { applicable: boolean };
        checks: { test: boolean; conformance: boolean };
      };
      assert.equal(data.lock.conformance, 'consistent');
      assert.deepEqual(data.test.missingMembers, []);
      assert.equal(data.test.includedDocTests, true);
      assert.equal(data.checks.test, true);
      assert.equal(data.checks.conformance, true);
      assert.equal(data.staleArtifacts.applicable, false);
    });
  },
);

test('a drifted lockfile fails the bundle before cargo can rewrite it', rustProject, async () => {
  await withFixture('basic-workspace', async (directory) => {
    await primeLockfile(directory);
    // Bump a member version so Cargo.lock no longer describes the workspace.
    const { readFile, writeFile } = await import('node:fs/promises');
    const manifestPath = `${directory}/crates/core/Cargo.toml`;
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, manifest.replace('version = "0.1.0"', 'version = "0.2.0"'));
    const value = await invokeTool('rust_validation_bundle', { execute: true }, directory);
    assertEnvelope(value, 'validation_bundle(drifted)');
    assert.equal(value.ok, false);
    const data = value.data as {
      lock: { conformance: string };
      preparation: { executed: boolean; skippedReason?: string };
      test: { executed: boolean };
    };
    assert.equal(data.lock.conformance, 'drifted');
    assert.equal(data.preparation.executed, false, 'a drifted lock must not be rewritten by check');
    assert.equal(data.test.executed, false);
    assert.ok(errorCodes(value).includes('VALIDATION_FAILED'));
  });
});

test('unused dependencies are reported from a bounded source scan', rustProject, async () => {
  await withFixture('unused-dependency', async (directory) => {
    const value = await invokeTool(
      'rust_project_inspect',
      { scanUnusedDependencies: true },
      directory,
    );
    assertEnvelope(value, 'project_inspect(unused)');
    assert.ok(warningCodes(value).includes('UNUSED_DEPENDENCY'));
    const data = value.data as {
      dependencies: { unused: { findings: { member: string; dependency: string }[] } | null };
    };
    assert.deepEqual(data.dependencies.unused?.findings, [
      { member: 'app', dependency: 'util', crate: 'util', kind: 'normal' },
    ]);
  });
});

test('a feature-gated compilation gap is checked only when requested', rustProject, async () => {
  await withFixture('basic-workspace', async (directory) => {
    await primeLockfile(directory);
    const skipped = await invokeTool(
      'rust_test_select',
      { changedPaths: ['crates/core/src/lib.rs'] },
      directory,
    );
    assertEnvelope(skipped, 'test_select(no feature check)');
    assert.equal(
      (skipped.data as { featureCheck: { executed: boolean } }).featureCheck.executed,
      false,
    );

    const checked = await invokeTool(
      'rust_test_select',
      { changedPaths: ['crates/core/src/lib.rs'], checkAllFeatures: true },
      directory,
    );
    assertEnvelope(checked, 'test_select(all features)');
    assert.equal(checked.ok, true, checked.summary);
    const featureCheck = (
      checked.data as { featureCheck: { executed: boolean; ok: boolean; errorCount: number } }
    ).featureCheck;
    assert.equal(featureCheck.executed, true);
    assert.equal(featureCheck.ok, true);
    assert.equal(featureCheck.errorCount, 0);
  });
});

test('the shared report type stays the shape the adapter promises', async () => {
  await withFixture('zero-tests', async (directory) => {
    const value = await invokeTool<TestData>('rust_test', { execute: true }, directory);
    const report = value.data as unknown as RustTestReport;
    assert.equal(typeof report.noTestsRan, 'boolean');
    assert.equal(typeof report.includedDocTests, 'boolean');
    assert.ok(Array.isArray(report.ranTargets));
  });
});
