import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  addWhitelistedGroup,
  approvePendingAccess,
  listAccess,
  rejectPendingAccess,
  removeTrustedUser,
  removeWhitelistedGroup,
  upsertTrustedUser,
} from "../src/access-control";

let dir: string | null = null;

function store() {
  dir = mkdtempSync(join(tmpdir(), "konoha-access-"));
  const path = join(dir, ".trusted-users.json");
  writeFileSync(path, JSON.stringify({
    owner: { name: "Owner", telegram_id: 1, username: "owner" },
    trusted: [],
    whitelisted_groups: [],
    pending: [
      { type: "user", name: "Pending User", telegram_id: 22, username: "pending" },
      { type: "group", chat_id: -10033, name: "Pending Group" },
    ],
  }));
  return { path, backupDir: join(dir, "backups") };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("access-control service", () => {
  test("upserts and removes trusted users", () => {
    const opts = store();
    const added = upsertTrustedUser({ name: "Natasha", telegram_id: 42, username: "@natasha", position: "PM" }, opts);
    expect((added.state as any).trusted).toHaveLength(1);
    expect(listAccess(opts).trusted[0].username).toBe("natasha");

    const removed = removeTrustedUser(42, opts);
    expect((removed.state as any).trusted).toHaveLength(0);
  });

  test("approves and rejects pending access entries", () => {
    const opts = store();
    const approved = approvePendingAccess({ type: "user", telegram_id: 22 }, opts);
    expect((approved.state as any).trusted[0].telegram_id).toBe(22);
    expect((approved.state as any).pending.some((p: any) => p.telegram_id === 22)).toBe(false);

    const rejected = rejectPendingAccess({ type: "group", chat_id: -10033, block: true }, opts);
    expect((rejected.state as any).pending.some((p: any) => p.chat_id === -10033)).toBe(false);
  });

  test("adds and removes whitelisted groups", () => {
    const opts = store();
    const added = addWhitelistedGroup(-10044, opts);
    expect((added.state as any).whitelisted_groups.some((g: any) => g.chat_id === -10044)).toBe(true);

    const removed = removeWhitelistedGroup(-10044, opts);
    expect((removed.state as any).whitelisted_groups.some((g: any) => g.chat_id === -10044)).toBe(false);
  });
});
