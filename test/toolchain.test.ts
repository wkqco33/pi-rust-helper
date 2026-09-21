import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  channelMatches,
  findToolchainFile,
  installedToolchains,
  isChannelName,
  matchDirectoryOverride,
  parseCargoVersion,
  parseRustcVv,
  parseRustupSettings,
  parseToolchainFile,
} from '../src/rust/toolchain.ts';

test('rustc -vV yields the release, host, and LLVM version', () => {
  const parsed = parseRustcVv(
    [
      'rustc 1.98.1 (48a229cea 2026-09-01)',
      'binary: rustc',
      'commit-hash: 48a229cea0000000000000000000000000000000',
      'commit-date: 2026-09-01',
      'host: x86_64-unknown-linux-gnu',
      'release: 1.98.1',
      'LLVM version: 22.1.8',
    ].join('\n'),
  );
  assert.equal(parsed?.release, '1.98.1');
  assert.equal(parsed?.host, 'x86_64-unknown-linux-gnu');
  assert.equal(parsed?.llvm, '22.1.8');
  assert.equal(parseRustcVv('not rustc output'), undefined);
});

test('cargo --version yields the version', () => {
  assert.equal(parseCargoVersion('cargo 1.98.1 (797e8a9bc 2026-08-05)')?.version, '1.98.1');
});

test('a TOML toolchain file exposes the channel, components, and targets', () => {
  const parsed = parseToolchainFile(
    [
      '[toolchain]',
      'channel = "nightly-2026-01-01"',
      'components = ["rustfmt", "clippy"]',
      'targets = ["wasm32-unknown-unknown"]',
      'profile = "minimal"',
    ].join('\n'),
    false,
  );
  assert.equal(parsed.channel, 'nightly-2026-01-01');
  assert.deepEqual(parsed.components, ['rustfmt', 'clippy']);
  assert.deepEqual(parsed.targets, ['wasm32-unknown-unknown']);
  assert.equal(parsed.profile, 'minimal');
});

test('a legacy one-line toolchain file is accepted', () => {
  const parsed = parseToolchainFile('stable\n', true);
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.channel, 'stable');
});

test('rustup settings expose the default and directory overrides', () => {
  const parsed = parseRustupSettings(
    [
      'version = "12"',
      'default_toolchain = "stable-x86_64-unknown-linux-gnu"',
      '',
      '[overrides]',
      '"/work/project" = "nightly-x86_64-unknown-linux-gnu"',
    ].join('\n'),
  );
  assert.equal(parsed.defaultToolchain, 'stable-x86_64-unknown-linux-gnu');
  assert.equal(parsed.overrides['/work/project'], 'nightly-x86_64-unknown-linux-gnu');
});

test('a channel matches its fully qualified toolchain directory', () => {
  assert.equal(channelMatches('stable', 'stable-x86_64-unknown-linux-gnu'), true);
  assert.equal(channelMatches('1.98.1', '1.98.1-x86_64-unknown-linux-gnu'), true);
  assert.equal(channelMatches('nightly', 'stable-x86_64-unknown-linux-gnu'), false);
  assert.equal(
    channelMatches('stable-x86_64-unknown-linux-gnu', 'stable-x86_64-unknown-linux-gnu'),
    true,
  );
});

test('a path-valued channel is not treated as a channel name', () => {
  assert.equal(isChannelName('stable'), true);
  assert.equal(isChannelName('./custom-toolchain'), false);
  assert.equal(isChannelName('/opt/toolchain'), false);
});

test('the longest directory override wins', () => {
  const override = matchDirectoryOverride(
    { '/work': 'stable', '/work/project': 'nightly' },
    '/work/project/crates/app',
  );
  assert.equal(override?.toolchain, 'nightly');
  assert.equal(matchDirectoryOverride({ '/other': 'stable' }, '/work')?.toolchain, undefined);
});

test('installed toolchains are read from the directory names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-rust-toolchains-'));
  try {
    await mkdir(join(home, 'stable-x86_64-unknown-linux-gnu'));
    await mkdir(join(home, '1.98.1-x86_64-unknown-linux-gnu'));
    await writeFile(join(home, 'not-a-directory'), 'x');
    const installed = await installedToolchains(home);
    assert.deepEqual(installed, [
      '1.98.1-x86_64-unknown-linux-gnu',
      'stable-x86_64-unknown-linux-gnu',
    ]);
    assert.deepEqual(await installedToolchains(join(home, 'missing')), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the nearest toolchain file is found by walking up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rust-file-'));
  try {
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
    const found = await findToolchainFile(join(root, 'nested', 'deeper'));
    assert.equal(found?.path, join(root, 'rust-toolchain.toml'));
    assert.equal(found?.legacy, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
