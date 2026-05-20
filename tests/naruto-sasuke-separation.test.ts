import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { CURRENT_TELEGRAM_CONNECTOR_CATALOG } from "../src/messenger-connectors";

const root = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("Naruto and Sasuke separation guardrail", () => {
  test("ADR documents the no-merge decision, compatibility tests, pause criteria, and rollback", () => {
    const adr = read("docs/adr-007-naruto-sasuke-separation.md");

    expect(adr).toContain("Keep Naruto and Sasuke separate");
    expect(adr).toContain("No merge, alias rewrite, watchdog consolidation");
    expect(adr).toContain("Sasuke chat ingestion is production-critical");
    expect(adr).toContain("Temporary Naruto Pause Experiment");
    expect(adr).toContain("Abort Criteria");
    expect(adr).toContain("Compatibility Test Matrix");
    expect(adr).toContain("Rollback Plan");
    expect(adr).toContain("XPENDING telegram:bot:incoming naruto");
    expect(adr).toContain("XPENDING telegram:incoming sasuke");
    expect(adr).toContain("XPENDING telegram:reaction_updates sasuke-reactions");
    expect(adr).toContain("scripts/telegram-smoke.sh");
    expect(adr).toContain("python3 scripts/healthcheck-system.py");
  });

  test("messenger compatibility catalog keeps bot and user-account identities separate", () => {
    const bot = CURRENT_TELEGRAM_CONNECTOR_CATALOG.endpoints.find(endpoint => endpoint.endpoint_id === "telegram-bot-naruto");
    const user = CURRENT_TELEGRAM_CONNECTOR_CATALOG.endpoints.find(endpoint => endpoint.endpoint_id === "telegram-user-sasuke");

    expect(bot?.compatibility_agent_id).toBe("naruto");
    expect(bot?.kind).toBe("bot");
    expect(bot?.inbound_streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "telegram:bot:incoming", group: "naruto" }),
    ]));

    expect(user?.compatibility_agent_id).toBe("sasuke");
    expect(user?.kind).toBe("user_account");
    expect(user?.inbound_streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "telegram:incoming", group: "sasuke" }),
      expect.objectContaining({ stream: "telegram:reaction_updates", group: "sasuke-reactions" }),
    ]));
  });

  test("architecture and connector docs link the consolidation guardrail", () => {
    expect(read("docs/architecture.md")).toContain("docs/adr-007-naruto-sasuke-separation.md");
    expect(read("docs/watchdog-architecture.md")).toContain("Sasuke user-account ingestion must remain");
    expect(read("docs/messenger-connectors.md")).toContain("must not\nmerge bot and user-account runtime identities");
    expect(read("docs/system-agent-roster.md")).toContain("Naruto and Sasuke remain separate connector-owned runtimes");
  });
});
