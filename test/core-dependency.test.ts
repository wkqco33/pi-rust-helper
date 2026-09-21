import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_SCHEMA_VERSION,
  classifyCommand,
  createResultFactory,
  selectTests,
  summarizeValidation,
  type SelectionSignals,
} from 'pi-helper-core';

/**
 * The whole pilot depends on `pi-helper-core` resolving as a real dependency
 * (through `exports`, not a relative path). If this fails, nothing else can be
 * built on it, so it is asserted before any Rust code exists.
 */
test('the shared core resolves as a package dependency', () => {
  assert.equal(CORE_SCHEMA_VERSION, 1);

  const { result, failure } = createResultFactory('0.1.0-test');
  const value = result('/tmp', Date.now(), {
    ok: true,
    summary: 'ok',
    evidence: [],
    warnings: [],
    errors: [],
    suggestions: [],
    toolchain: { kind: 'rust', version: '1.98.1', source: 'override' },
  });
  assert.equal(value.metadata.toolchain?.kind, 'rust');
  assert.equal(value.metadata.toolVersion, '0.1.0-test');
  assert.equal(value.attention, false);
  assert.equal(failure('/tmp', Date.now(), 'boom', 'E').ok, false);
});

test('the core supplies the shared behaviours the Rust tools will use', () => {
  // Universal rules apply with no adapter rules; cargo rules are added later.
  assert.equal(classifyCommand('git status && git push --force').risk, 'irreversible');
  assert.equal(classifyCommand('git status').risk, 'read');

  const gate = summarizeValidation({
    lock: { executed: true, ok: true },
    preparation: { executed: true, ok: true },
    // A run that executed no test is exactly the false green this pilot targets.
    test: { executed: true, ok: true, failures: 0, noTestsRan: true },
    conformance: 'consistent',
    stale: false,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /without executing any test/);

  const signals: SelectionSignals = {
    isSourceFile: (path) => path.endsWith('.rs'),
    isTestFile: (path) => path.startsWith('tests/') || path.endsWith('_test.rs'),
    isRunnableTestFile: (path) => path.startsWith('tests/'),
    pathTokens: (path) =>
      path
        .replace(/\.[A-Za-z0-9]+$/, '')
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3),
    moduleNamesForFile: (path) => [path.replace(/\.rs$/, '').replace(/\//g, '::')],
    packageName: (path) => path.split('/')[0],
    supportFileNames: new Set(['common.rs']),
  };
  const selection = selectTests(
    ['src/parser.rs'],
    ['tests/parser_test.rs', 'tests/other_test.rs'],
    signals,
  );
  assert.equal(selection.selected[0].path, 'tests/parser_test.rs');
});
