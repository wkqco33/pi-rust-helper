import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderToolsDoc } from './tool-manifest.ts';

/**
 * A tool's schema is part of its contract with the model, so the generated
 * document is checked in and compared here. A mismatch means the tool changed
 * without the docs being regenerated.
 */
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'docs', 'tools.md');

let actual: string;
try {
  actual = await readFile(target, 'utf8');
} catch {
  console.error(`docs/tools.md is missing. Run \`npm run docs\`.`);
  process.exit(1);
}

const expected = renderToolsDoc();
if (actual !== expected) {
  console.error('docs/tools.md is out of date with the registered tools.');
  console.error('Run `npm run docs` and commit the result.');
  process.exit(1);
}
console.log('docs/tools.md matches the registered tools.');
