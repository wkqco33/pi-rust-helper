import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAllTools } from './tools/index.ts';

export default function (pi: ExtensionAPI): void {
  registerAllTools(pi);
}
