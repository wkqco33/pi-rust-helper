import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderToolsDoc } from './tool-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'docs', 'tools.md');
await writeFile(target, renderToolsDoc(), 'utf8');
console.log(`wrote ${target}`);
