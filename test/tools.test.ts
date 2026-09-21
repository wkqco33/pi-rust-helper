import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allTools,
  assertEnvelope,
  errorCodes,
  invokeTool,
  warningCodes,
  withFixture,
} from './helpers/harness.ts';

test('the extension registers a capped, consistently named set of tools', () => {
  const tools = allTools();
  assert.equal(tools.length, 10);
  assert.ok(tools.length <= 10, 'the tool count cap is 10');
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.match(tool.name, /^rust_/, `${tool.name} must use the rust_ prefix`);
    assert.ok(tool.label.length > 0, `${tool.name} needs a label`);
    assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
    assert.ok(tool.promptSnippet && tool.promptSnippet.length > 0, `${tool.name} needs a snippet`);
    assert.equal(
      (tool.parameters as { type?: string }).type,
      'object',
      `${tool.name} must take an object`,
    );
  }
});

test('command previews report that nothing was executed', async () => {
  await withFixture('basic-workspace', async (directory) => {
    for (const [name, params] of [
      ['rust_test', {}],
      ['rust_check', {}],
      ['rust_build', {}],
    ] as const) {
      const value = await invokeTool(name, params, directory);
      assertEnvelope(value, name);
      assert.equal(value.ok, false, `${name} preview must not claim a pass`);
      assert.ok(warningCodes(value).includes('PREVIEW_ONLY'), `${name} preview must disclose that`);
      assert.equal(value.commands?.length, 1);
    }

    const build = await invokeTool('rust_build', {}, directory);
    assert.equal(build.commands?.[0].risk, 'mutating');
  });
});

test('rust_failure_diagnose turns structured output into a project frame', async () => {
  const output = JSON.stringify({
    reason: 'compiler-message',
    message: {
      level: 'error',
      code: { code: 'E0599' },
      message: 'no method named `nope` found',
      spans: [{ file_name: 'src/lib.rs', line_start: 4, column_start: 3, is_primary: true }],
    },
  });
  const value = await invokeTool(
    'rust_failure_diagnose',
    { output, path: process.cwd() },
    process.cwd(),
  );
  assertEnvelope(value, 'rust_failure_diagnose');
  assert.equal(value.ok, false);
  assert.ok(errorCodes(value).includes('FAILURE_DIAGNOSED'));
  const data = value.data as { kind: string; firstUserFrame?: { path: string; line: number } };
  assert.equal(data.kind, 'no_method');
  assert.equal(data.firstUserFrame?.path, 'src/lib.rs');
  assert.equal(data.firstUserFrame?.line, 4);
});

test('rust_tdd_checkpoint accepts a related test change', async () => {
  const value = await invokeTool(
    'rust_tdd_checkpoint',
    {
      changedPaths: ['crates/core/src/parser.rs'],
      testChangedPaths: ['crates/core/tests/parser_test.rs'],
    },
    process.cwd(),
  );
  assertEnvelope(value, 'rust_tdd_checkpoint');
  assert.equal(value.ok, true);
  const data = value.data as { associations: { strength: string }[] };
  assert.ok(data.associations.length > 0);
});

test('rust_completion_evidence blocks an unproven completion', async () => {
  const insufficient = await invokeTool(
    'rust_completion_evidence',
    {
      preparationExecuted: false,
      preparationOk: false,
      testExecuted: false,
      testOk: false,
      stale: false,
      changedPaths: ['src/lib.rs'],
    },
    process.cwd(),
  );
  assertEnvelope(insufficient, 'completion_evidence');
  assert.equal(insufficient.ok, false);
  assert.ok(errorCodes(insufficient).includes('COMPLETION_NOT_PROVEN'));

  const sufficient = await invokeTool(
    'rust_completion_evidence',
    {
      preparationExecuted: true,
      preparationOk: true,
      testExecuted: true,
      testOk: true,
      stale: false,
      changedPaths: ['src/lib.rs'],
    },
    process.cwd(),
  );
  assertEnvelope(sufficient, 'completion_evidence');
  assert.equal(sufficient.ok, true);
  assert.equal(sufficient.attention, false);
});

test('rust_environment returns a valid envelope with or without a toolchain', async () => {
  await withFixture('basic-workspace', async (directory) => {
    const value = await invokeTool('rust_environment', {}, directory);
    assertEnvelope(value, 'rust_environment');
    const data = value.data as { toolchainFile: { channel?: string } | null };
    assert.equal(data.toolchainFile?.channel, 'stable');
  });
});

test('a missing project is a failure with an actionable diagnostic', async () => {
  const value = await invokeTool(
    'rust_project_inspect',
    { path: '/definitely/not/a/project' },
    process.cwd(),
  );
  assertEnvelope(value, 'rust_project_inspect');
  assert.equal(value.ok, false);
  assert.ok(errorCodes(value).includes('PROJECT_NOT_FOUND'));
});
