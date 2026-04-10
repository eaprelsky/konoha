/**
 * Plugin registry — the ONLY place in the build that imports from module packages.
 * Core code must not import from modules/ directly; modules register here.
 *
 * To add a new module: import its plugin and append to PLUGINS.
 */
import type { KonohaFrontendPlugin } from '@core/plugin';
import { workflowPlugin } from '@workflow/plugin';

export const PLUGINS: KonohaFrontendPlugin[] = [workflowPlugin];
