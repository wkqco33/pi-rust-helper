import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerBuildTools } from './build.ts';
import { registerEnvironmentTools } from './environment.ts';
import { registerProjectTools } from './project.ts';
import { registerTestingTools } from './testing.ts';
import { registerValidationTools } from './validation.ts';

export * from './build.ts';
export * from './environment.ts';
export * from './project.ts';
export * from './testing.ts';
export * from './validation.ts';
export * from './shared.ts';

/**
 * Tool registration is the helper's own responsibility; the shared core never
 * calls `registerTool`. The list is capped deliberately (R7): a new capability
 * should extend an existing tool with a parameter rather than add an eleventh
 * name the agent has to choose between.
 */
export function registerAllTools(pi: ExtensionAPI): void {
  registerEnvironmentTools(pi);
  registerProjectTools(pi);
  registerTestingTools(pi);
  registerBuildTools(pi);
  registerValidationTools(pi);
}
