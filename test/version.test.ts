import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CORE_SCHEMA_VERSION } from 'pi-helper-core';
import { TOOL_VERSION } from '../src/core/version.ts';

test('the reported version matches package.json', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(TOOL_VERSION, manifest.version);
});

test('the helper targets the schema version the core publishes', () => {
  assert.equal(CORE_SCHEMA_VERSION, 1);
});
