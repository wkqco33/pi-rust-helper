import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnoseRustFailure,
  isLibraryFrame,
  parseCompilerDiagnostics,
} from '../src/rust/failure.ts';

const message = (
  level: string,
  code: string | null,
  text: string,
  span: { file_name?: string; line_start?: number; is_primary?: boolean },
): string =>
  JSON.stringify({
    reason: 'compiler-message',
    message: {
      level,
      code: code ? { code } : null,
      message: text,
      spans: span.file_name
        ? [
            {
              file_name: span.file_name,
              line_start: span.line_start,
              column_start: 1,
              is_primary: span.is_primary ?? true,
            },
          ]
        : [],
      children: [],
    },
  });

test('structured JSON points at the first project frame', () => {
  const output = message('error', 'E0599', 'no method named `not_a_method` found', {
    file_name: 'src/lib.rs',
    line_start: 3,
  });
  const diagnosis = diagnoseRustFailure(output, { projectRoot: '/ws' });
  assert.equal(diagnosis.kind, 'no_method');
  assert.equal(diagnosis.exceptionType, 'E0599');
  assert.equal(diagnosis.firstUserFrame?.path, 'src/lib.rs');
  assert.equal(diagnosis.firstUserFrame?.line, 3);
  assert.equal(diagnosis.frames[0].library, false);
  assert.ok(diagnosis.suggestions.some((entry) => /--explain E0599/.test(entry.message)));
});

test('a registry-only span is a library frame, not the cause', () => {
  const output = message('error', 'E0308', 'mismatched types', {
    file_name: '/home/u/.cargo/registry/src/index.crates.io-1/serde-1.0.0/src/lib.rs',
    line_start: 10,
  });
  const diagnosis = diagnoseRustFailure(output, { projectRoot: '/ws' });
  assert.equal(diagnosis.frames[0].library, true);
  assert.equal(diagnosis.firstUserFrame, undefined);
});

test('an unresolved import names the missing crate and suggests adding it', () => {
  const output = message('error', 'E0432', 'unresolved import `serde_json`', {
    file_name: 'src/main.rs',
    line_start: 1,
  });
  const diagnosis = diagnoseRustFailure(output, { projectRoot: '/ws' });
  assert.equal(diagnosis.kind, 'unresolved_import');
  assert.equal(diagnosis.missingModule, 'serde_json');
  assert.ok(diagnosis.suggestions.some((entry) => entry.command === 'cargo add serde_json'));
});

test('a feature-gated method is classified separately from a missing one', () => {
  const output = message('error', 'E0599', 'the item is gated behind the `serde` feature', {
    file_name: 'src/lib.rs',
    line_start: 7,
  });
  const diagnosis = diagnoseRustFailure(output, { projectRoot: '/ws' });
  assert.equal(diagnosis.kind, 'feature_gated');
  assert.ok(diagnosis.suggestions.some((entry) => entry.command?.includes('--all-features')));
});

test('the text fallback still finds a project frame', () => {
  const output = [
    'error[E0277]: the trait bound `Foo: Bar` is not satisfied',
    ' --> src/lib.rs:4:5',
    '  |',
    '4 |     foo.bar();',
    '  |     ^^^ the trait `Bar` is not implemented',
  ].join('\n');
  const diagnosis = diagnoseRustFailure(output, { projectRoot: '/ws' });
  assert.equal(diagnosis.kind, 'trait_bound');
  assert.equal(diagnosis.exceptionType, 'E0277');
  assert.equal(diagnosis.firstUserFrame?.path, 'src/lib.rs');
  assert.equal(diagnosis.firstUserFrame?.line, 4);
});

test('a missing cargo subcommand is named', () => {
  const diagnosis = diagnoseRustFailure('error: no such command: `nextest`', {});
  assert.equal(diagnosis.kind, 'missing_executable');
  assert.equal(diagnosis.missingExecutable, 'nextest');
  assert.ok(
    diagnosis.suggestions.some((entry) => entry.command === 'cargo install --locked nextest'),
  );
});

test('unrecognized output is reported as unknown, without inventing a cause', () => {
  const diagnosis = diagnoseRustFailure('everything is fine, nothing to see here', {});
  assert.equal(diagnosis.kind, 'unknown');
  assert.equal(diagnosis.firstUserFrame, undefined);
  assert.ok(diagnosis.suggestions.length > 0);
});

test('compiler diagnostics are counted by level and code', () => {
  const output = [
    message('error', 'E0599', 'no method', { file_name: 'src/lib.rs', line_start: 3 }),
    message('warning', null, 'unused variable', { file_name: 'src/lib.rs', line_start: 9 }),
    message('error', 'E0308', 'mismatched types', { file_name: 'src/main.rs', line_start: 2 }),
  ].join('\n');
  const diagnostics = parseCompilerDiagnostics(output, { projectRoot: '/ws' });
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code ?? null),
    ['E0599', null, 'E0308'],
  );
  assert.equal(diagnostics.filter((entry) => entry.level === 'error').length, 2);
  assert.equal(diagnostics[1].library, false);
});

test('library frame detection matches cargo, rustup, and std paths', () => {
  assert.equal(isLibraryFrame('src/lib.rs', {}), false);
  assert.equal(isLibraryFrame('/ws/src/lib.rs', { projectRoot: '/ws' }), false);
  assert.equal(isLibraryFrame('/home/u/.cargo/registry/src/x/serde-1.0.0/src/lib.rs', {}), true);
  assert.equal(
    isLibraryFrame(
      '/home/u/.rustup/toolchains/stable-x86_64/lib/rustlib/src/rust/library/core/src/lib.rs',
      {},
    ),
    true,
  );
  assert.equal(isLibraryFrame('/rustc/abc/library/std/src/lib.rs', {}), true);
});
