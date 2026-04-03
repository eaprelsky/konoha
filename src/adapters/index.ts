// Adapter registry for Konoha workflow runtime
// When a work item has system=X and adapter X is registered, it auto-executes

import type { Adapter } from "./bitrix24";
export type { Adapter };

const registry = new Map<string, Adapter>();

export function registerAdapter(system: string, adapter: Adapter): void {
  registry.set(system, adapter);
}

export function getAdapter(system: string): Adapter | undefined {
  return registry.get(system);
}

export function listAdapters(): string[] {
  return [...registry.keys()];
}

// Register built-in adapters (lazy load to avoid startup crashes if env vars missing)
import { bitrix24Adapter } from "./bitrix24";
import { telegramAdapter } from "./telegram";
import { emailAdapter } from "./email";
import { yonoteAdapter } from "./yonote";
import { yandexTrackerAdapter } from "./yandex-tracker";

registerAdapter("bitrix24", bitrix24Adapter);
registerAdapter("telegram", telegramAdapter);
registerAdapter("email", emailAdapter);
registerAdapter("yonote", yonoteAdapter);
registerAdapter("yandex-tracker", yandexTrackerAdapter);
