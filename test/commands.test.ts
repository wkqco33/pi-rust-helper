import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCommand } from 'pi-helper-core';
import {
  cargoBuildCommand,
  cargoCheckCommand,
  cargoClippyCommand,
  cargoFmtCheckCommand,
  cargoTestCommand,
  metadataCommand,
} from '../src/rust/commands.ts';
import { CARGO_RISK_RULES } from '../src/rust/risk.ts';

const ctx = { cwd: '/work', projectRoot: '/work' };

test('the test command covers the whole workspace by default', () => {
  const command = cargoTestCommand({}, ctx);
  assert.deepEqual(command.args.slice(0, 2), ['test', '--workspace']);
  assert.ok(command.args.includes('--message-format=json'));
  assert.equal(command.risk, 'read');
});

test('workspace:false reproduces a bare cargo test', () => {
  const command = cargoTestCommand({ workspace: false }, ctx);
  assert.equal(command.args.includes('--workspace'), false);
  assert.deepEqual(command.args.slice(0, 1), ['test']);
});

test('targets become -p flags instead of the workspace flag', () => {
  const command = cargoTestCommand({ targets: ['probe-core', 'probe-app'] }, ctx);
  assert.deepEqual(command.args.slice(0, 5), ['test', '-p', 'probe-core', '-p', 'probe-app']);
  assert.equal(command.args.includes('--workspace'), false);
});

test('docTests:false excludes documentation tests', () => {
  const command = cargoTestCommand({ docTests: false }, ctx);
  assert.ok(command.args.includes('--tests'));
});

test('feature selection becomes the cargo feature flag', () => {
  assert.ok(cargoTestCommand({ features: 'all' }, ctx).args.includes('--all-features'));
  assert.ok(cargoTestCommand({ features: 'none' }, ctx).args.includes('--no-default-features'));
  assert.equal(
    cargoTestCommand({ features: 'default' }, ctx).args.includes('--all-features'),
    false,
  );
});

test('check and clippy keep diagnostics structured', () => {
  for (const command of [
    cargoCheckCommand({ allTargets: true }, ctx),
    cargoClippyCommand({}, ctx),
  ]) {
    assert.ok(command.args.includes('--message-format=json'));
    assert.ok(command.args.includes('--all-targets') || command.args[0] === 'clippy');
  }
  assert.deepEqual(cargoFmtCheckCommand(ctx).args, ['fmt', '--all', '--check']);
});

test('metadata is offline unless asked otherwise', () => {
  assert.ok(metadataCommand(ctx).args.includes('--offline'));
  assert.ok(metadataCommand(ctx, { locked: true }).args.includes('--locked'));
  assert.ok(metadataCommand(ctx, { noDeps: true }).args.includes('--no-deps'));
  assert.equal(metadataCommand(ctx, { offline: false }).args.includes('--offline'), false);
});

test('cargo risk rules classify read, mutating, and irreversible commands', () => {
  const rules = { patterns: CARGO_RISK_RULES };
  assert.equal(classifyCommand('cargo metadata --format-version 1', rules).risk, 'read');
  assert.equal(classifyCommand('cargo check --workspace', rules).risk, 'read');
  assert.equal(classifyCommand('cargo test --workspace', rules).risk, 'read');
  assert.equal(classifyCommand('cargo build --workspace', rules).risk, 'mutating');
  assert.equal(classifyCommand('cargo fetch', rules).risk, 'mutating');
  assert.equal(classifyCommand('cargo clean', rules).risk, 'irreversible');
  assert.equal(classifyCommand('cargo publish', rules).risk, 'irreversible');
  assert.equal(classifyCommand('cargo add serde', rules).risk, 'irreversible');
  assert.equal(classifyCommand('rustup toolchain install nightly', rules).risk, 'mutating');
});

test('the build command is classified as mutating', () => {
  assert.equal(cargoBuildCommand({}, ctx).risk, 'mutating');
  assert.equal(
    cargoBuildCommand({ targets: ['probe-app'] }, ctx).args.includes('--workspace'),
    false,
  );
});

test('a compound command inherits the highest segment risk', () => {
  assert.equal(
    classifyCommand('cargo test && cargo clean', { patterns: CARGO_RISK_RULES }).risk,
    'irreversible',
  );
});
