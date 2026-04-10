/**
 * Ambient module declarations for external plugin packages.
 * These modules live outside the frontend/ tree and are resolved by Vite
 * at build time. We declare their types here so tsc can type-check
 * registry.ts without traversing the entire module source trees.
 */

declare module '@core/plugin' {
  import type { ComponentType, LazyExoticComponent } from 'react';

  export interface NavItem { path: string; keyRu: string; keyEn: string; }
  export interface NavGroupDef { id: string; keyRu: string; keyEn: string; items: NavItem[]; }
  export interface RouteDefinition {
    path: string;
    component: LazyExoticComponent<ComponentType<unknown>> | ComponentType<unknown>;
  }
  export interface KonohaFrontendPlugin { navGroups: NavGroupDef[]; routes: RouteDefinition[]; }
}

declare module '@workflow/plugin' {
  import type { KonohaFrontendPlugin } from '@core/plugin';
  export const workflowPlugin: KonohaFrontendPlugin;
}
