import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { ServiceError } from "./errors";

export const TRUSTED_USERS_PATH = "/opt/shared/.trusted-users.json";
export const TRUSTED_USERS_BACKUP_DIR = "/opt/shared/trusted-users-backups";

export interface TrustedUser {
  name: string;
  telegram_id: number;
  username?: string | null;
  phone?: string | null;
  email?: string | null;
  position?: string;
  relation?: string;
  level?: number;
}

export interface PendingEntry {
  type: "user" | "group";
  name?: string;
  telegram_id?: number;
  chat_id?: number;
  username?: string | null;
  last_seen?: string;
  source?: "direct" | "group";
  member_count?: number;
}

export interface TrustedUsersFile {
  owner?: TrustedUser;
  trusted?: TrustedUser[];
  whitelisted_groups?: number[];
  blocked?: number[];
  pending?: PendingEntry[];
}

export interface WhitelistData {
  owner: TrustedUser | null;
  trusted: Array<Omit<TrustedUser, "position" | "username" | "level"> & {
    type: "user";
    status: "approved";
    username: string | null;
    position: string | null;
    level: number;
  }>;
  whitelisted_groups: Array<{ type: "group"; chat_id: number; name: null; status: "approved" }>;
  pending: Array<PendingEntry & { status: "pending" }>;
}

export interface AccessStoreOptions {
  path?: string;
  backupDir?: string;
}

function readFile(path: string): TrustedUsersFile {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { trusted: [], whitelisted_groups: [], pending: [] };
  }
}

function writeFile(data: TrustedUsersFile, opts: Required<AccessStoreOptions>): void {
  if (existsSync(opts.path)) {
    mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(opts.path, `${opts.backupDir}/trusted-users.${stamp}.json`);
  } else {
    mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${opts.path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, opts.path);
}

function storeOptions(opts: AccessStoreOptions = {}): Required<AccessStoreOptions> {
  return {
    path: opts.path ?? TRUSTED_USERS_PATH,
    backupDir: opts.backupDir ?? TRUSTED_USERS_BACKUP_DIR,
  };
}

function toData(data: TrustedUsersFile): WhitelistData {
  return {
    owner: data.owner ?? null,
    trusted: (data.trusted ?? []).map(u => ({
      ...u,
      type: "user" as const,
      username: u.username ?? null,
      position: u.position ?? null,
      level: u.level ?? 2,
      status: "approved" as const,
    })),
    whitelisted_groups: (data.whitelisted_groups ?? []).map(chat_id => ({
      type: "group" as const,
      chat_id,
      name: null,
      status: "approved" as const,
    })),
    pending: (data.pending ?? []).map(p => ({ ...p, status: "pending" as const })),
  };
}

function withState(result: Record<string, unknown>, data: TrustedUsersFile): Record<string, unknown> {
  return { ...result, state: toData(data) };
}

export function listAccess(opts?: AccessStoreOptions): WhitelistData {
  return toData(readFile(storeOptions(opts).path));
}

export function upsertTrustedUser(input: Partial<TrustedUser>, opts?: AccessStoreOptions): Record<string, unknown> {
  if (!input.name?.trim()) throw new ServiceError(400, "name required");
  if (typeof input.telegram_id !== "number" || Number.isNaN(input.telegram_id)) {
    throw new ServiceError(400, "telegram_id required");
  }
  const options = storeOptions(opts);
  const data = readFile(options.path);
  const trusted = data.trusted ?? [];
  const user: TrustedUser = {
    name: input.name.trim(),
    telegram_id: input.telegram_id,
    username: input.username?.trim().replace(/^@/, "") || null,
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    position: input.position?.trim() || undefined,
    relation: input.relation?.trim() || undefined,
    level: typeof input.level === "number" ? input.level : 2,
  };
  const index = trusted.findIndex(u => u.telegram_id === user.telegram_id);
  if (index >= 0) trusted[index] = { ...trusted[index], ...user };
  else trusted.push(user);
  data.trusted = trusted;
  data.pending = (data.pending ?? []).filter(p => !(p.type === "user" && p.telegram_id === user.telegram_id));
  writeFile(data, options);
  return withState({ ok: true, user }, data);
}

export function addWhitelistedGroup(chat_id: number, opts?: AccessStoreOptions): Record<string, unknown> {
  if (typeof chat_id !== "number" || Number.isNaN(chat_id)) throw new ServiceError(400, "chat_id required");
  const options = storeOptions(opts);
  const data = readFile(options.path);
  data.whitelisted_groups = data.whitelisted_groups ?? [];
  if (!data.whitelisted_groups.includes(chat_id)) data.whitelisted_groups.push(chat_id);
  data.pending = (data.pending ?? []).filter(p => !(p.type === "group" && p.chat_id === chat_id));
  writeFile(data, options);
  return withState({ ok: true, group: { chat_id } }, data);
}

export function approvePendingAccess(input: { type: "user" | "group"; telegram_id?: number; chat_id?: number }, opts?: AccessStoreOptions): Record<string, unknown> {
  const options = storeOptions(opts);
  const data = readFile(options.path);
  const pending = data.pending ?? [];

  if (input.type === "user" && input.telegram_id) {
    const entry = pending.find(p => p.type === "user" && p.telegram_id === input.telegram_id);
    if (!entry) throw new ServiceError(404, "Pending entry not found");
    const result = upsertTrustedUser({
      name: entry.name ?? `User ${input.telegram_id}`,
      telegram_id: input.telegram_id,
      username: entry.username ?? null,
      level: 2,
    }, options);
    return { ...result, approved: "user", telegram_id: input.telegram_id };
  }

  if (input.type === "group" && input.chat_id) {
    const entry = pending.find(p => p.type === "group" && p.chat_id === input.chat_id);
    if (!entry) throw new ServiceError(404, "Pending entry not found");
    const result = addWhitelistedGroup(input.chat_id, options);
    return { ...result, approved: "group", chat_id: input.chat_id };
  }

  throw new ServiceError(400, "type and telegram_id/chat_id required");
}

export function rejectPendingAccess(input: { type: "user" | "group"; telegram_id?: number; chat_id?: number; block?: boolean }, opts?: AccessStoreOptions): Record<string, unknown> {
  const options = storeOptions(opts);
  const data = readFile(options.path);
  const pending = data.pending ?? [];

  if (input.type === "user" && input.telegram_id) {
    data.pending = pending.filter(p => !(p.type === "user" && p.telegram_id === input.telegram_id));
    if (bodyShouldBlock(input)) {
      data.blocked = data.blocked ?? [];
      if (!data.blocked.includes(input.telegram_id)) data.blocked.push(input.telegram_id);
    }
    writeFile(data, options);
    return withState({ ok: true, rejected: "user", telegram_id: input.telegram_id }, data);
  }

  if (input.type === "group" && input.chat_id) {
    data.pending = pending.filter(p => !(p.type === "group" && p.chat_id === input.chat_id));
    if (bodyShouldBlock(input)) {
      data.blocked = data.blocked ?? [];
      if (!data.blocked.includes(input.chat_id)) data.blocked.push(input.chat_id);
    }
    writeFile(data, options);
    return withState({ ok: true, rejected: "group", chat_id: input.chat_id }, data);
  }

  throw new ServiceError(400, "type and telegram_id/chat_id required");
}

export function removeTrustedUser(telegram_id: number, opts?: AccessStoreOptions): Record<string, unknown> {
  if (typeof telegram_id !== "number" || Number.isNaN(telegram_id)) throw new ServiceError(400, "Invalid telegram_id");
  const options = storeOptions(opts);
  const data = readFile(options.path);
  const before = (data.trusted ?? []).length;
  data.trusted = (data.trusted ?? []).filter(u => u.telegram_id !== telegram_id);
  if (data.trusted.length === before) throw new ServiceError(404, "User not found");
  writeFile(data, options);
  return withState({ ok: true, removed: "user", telegram_id }, data);
}

export function removeWhitelistedGroup(chat_id: number, opts?: AccessStoreOptions): Record<string, unknown> {
  if (typeof chat_id !== "number" || Number.isNaN(chat_id)) throw new ServiceError(400, "Invalid chat_id");
  const options = storeOptions(opts);
  const data = readFile(options.path);
  const before = (data.whitelisted_groups ?? []).length;
  data.whitelisted_groups = (data.whitelisted_groups ?? []).filter(id => id !== chat_id);
  if (data.whitelisted_groups.length === before) throw new ServiceError(404, "Group not found");
  writeFile(data, options);
  return withState({ ok: true, removed: "group", chat_id }, data);
}

function bodyShouldBlock(input: { block?: boolean }): boolean {
  return input.block === true;
}
