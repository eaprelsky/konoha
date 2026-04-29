import { describe, expect, test } from "bun:test";
import { renderSystemTemplate } from "../src/agent/prompt";

describe("agent prompt identity", () => {
  test("renders canonical name and mutable display alias separately", () => {
    const template = renderSystemTemplate({
      id: "sasuke",
      name: "Юзер-агент",
      display_alias: "Саске",
      runtime: "claude",
      model: "claude:sonnet",
    });

    expect(template).toContain("- Agent ID: sasuke");
    expect(template).toContain("- Agent Name: Юзер-агент");
    expect(template).toContain("- Agent Display Alias: Саске");
    expect(template).toContain("konoha_register(id=sasuke, name=Юзер-агент, display_alias=Саске");
  });

  test("falls back to canonical name when display alias is absent", () => {
    const template = renderSystemTemplate({
      id: "advisor",
      name: "Советник",
      model: "claude:sonnet",
    });

    expect(template).toContain("- Agent Display Alias: Советник");
    expect(template).toContain("display_alias=Советник");
  });
});
