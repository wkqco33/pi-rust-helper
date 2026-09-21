import assert from 'node:assert/strict';
import test from 'node:test';
import { packageNameFromId, parseTestOutput } from '../src/rust/output.ts';

const artifact = (id: string, target: string, kind: string, executable: string): string =>
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: id,
    target: { kind: [kind], name: target },
    profile: { test: true },
    executable,
  });

const APP = 'path+file:///ws/crates/app#probe-app@0.1.0';
const CORE = 'path+file:///ws/crates/core#probe-core@0.1.0';

const WORKSPACE_RUN = [
  artifact(APP, 'probe-app', 'bin', '/ws/target/debug/deps/probe_app-1'),
  '     Running unittests src/main.rs (/ws/target/debug/deps/probe_app-1)',
  '',
  'running 1 test',
  'test tests::app_adds ... ok',
  '',
  'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  artifact(CORE, 'probe_core', 'lib', '/ws/target/debug/deps/probe_core-1'),
  '     Running unittests src/lib.rs (/ws/target/debug/deps/probe_core-1)',
  '',
  'running 1 test',
  'test tests::core_adds ... ok',
  '',
  'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  '   Doc-tests probe_core',
  '',
  'running 1 test',
  'test crates/core/src/lib.rs - add (line 3) ... ok',
  '',
  'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s',
  '',
].join('\n');

test('a workspace run reports every package that produced a test binary', () => {
  const report = parseTestOutput(WORKSPACE_RUN, '');
  assert.deepEqual(report.testedPackages, ['probe-app', 'probe-core']);
  assert.deepEqual(report.ranTargets, ['probe-app (probe-app)', 'probe-core (probe_core)']);
  assert.equal(report.includedDocTests, true);
  assert.equal(report.counts.passed, 3);
  assert.equal(report.noTestsRan, false);
  assert.equal(report.incomplete, false);
  assert.equal(report.sections.length, 3);
});

test('a default-members run only reaches the members it produced artifacts for', () => {
  const output = [
    artifact(APP, 'probe-app', 'bin', '/ws/target/debug/deps/probe_app-1'),
    '     Running unittests src/main.rs (/ws/target/debug/deps/probe_app-1)',
    '',
    'running 1 test',
    'test tests::app_adds ... ok',
    '',
    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ].join('\n');
  const report = parseTestOutput(output, '');
  assert.deepEqual(report.testedPackages, ['probe-app']);
  assert.equal(report.includedDocTests, false);
});

test('a run with no tests is detected rather than reported as a pass', () => {
  const output = [
    '     Running unittests src/lib.rs (/ws/target/debug/deps/zero-1)',
    '',
    'running 0 tests',
    '',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
    '   Doc-tests zero',
    '',
    'running 0 tests',
    '',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ].join('\n');
  const report = parseTestOutput(output, '');
  assert.equal(report.noTestsRan, true);
  assert.equal(report.counts.passed, 0);
  assert.equal(report.includedDocTests, true);
  assert.equal(report.incomplete, false);
});

test('--tests output has no Doc-tests section', () => {
  const output = WORKSPACE_RUN.replace(/   Doc-tests probe_core[\s\S]*$/, '');
  const report = parseTestOutput(output, '');
  assert.equal(report.includedDocTests, false);
  assert.equal(report.counts.passed, 2);
});

test('a failing test carries its name, message, file, and line', () => {
  const output = [
    '     Running unittests src/lib.rs (/ws/target/debug/deps/x-1)',
    '',
    'running 1 test',
    'test tests::fails ... FAILED',
    '',
    'failures:',
    '',
    '---- tests::fails stdout ----',
    "thread 'tests::fails' panicked at src/lib.rs:5:5:",
    'assertion `left == right` failed',
    '  left: 1',
    ' right: 2',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    '',
    '',
    'failures:',
    '    tests::fails',
    '',
    'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ].join('\n');
  const report = parseTestOutput(output, '');
  assert.equal(report.counts.failed, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].test, 'tests::fails');
  assert.equal(report.failures[0].file, 'src/lib.rs');
  assert.equal(report.failures[0].line, 5);
  assert.match(report.failures[0].message, /assertion/);
});

test('a build failure leaves the report incomplete', () => {
  const stderr = [
    'error[E0599]: no method named `not_a_method` found for reference `&str` in the current scope',
    ' --> src/lib.rs:3:11',
    'error: could not compile `broken` (lib) due to 1 previous error',
  ].join('\n');
  const report = parseTestOutput('', stderr);
  assert.equal(report.incomplete, true);
  assert.equal(report.noTestsRan, false);
  assert.ok(report.compileErrorCount >= 1);
  assert.match(report.commandError ?? '', /could not compile/);
});

test('package ids reduce to the package name', () => {
  assert.equal(packageNameFromId(APP), 'probe-app');
  assert.equal(
    packageNameFromId('registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0'),
    'serde',
  );
});
