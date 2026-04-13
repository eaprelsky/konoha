# Skills — User Guide

A skill is an extension package for an AI agent: additional instructions and/or tools (MCP servers). A skill is assigned to an agent and takes effect on the next launch.

---

## Viewing Skills

The **Executors → Skills** section shows all available skills.

For each skill the following is displayed:
- Name
- Description
- Whether MCP tools are present (yes/no)
- Whether instructions are present (prompt snippet)

---

## Creating a Skill

1. Click **Create skill**
2. Fill in the fields:
   - **Name** — human-readable name (e.g., "Yandex Tracker")
   - **Description** — what this skill can do
   - **Instructions (prompt snippet)** — text that will be added to the agent's AGENTS.md. For example: how to use the tools, what commands are available, when to use them
   - **MCP servers** — description of additional tools (filled in JSON format; usually configured by an administrator)
3. Click **Save**

---

## How a Skill Works

When an agent with an assigned skill is launched:

1. **Instructions** from the skill are added to the agent's AGENTS.md in the `## Skill: {name}` block
2. **MCP servers** from the skill are added to the `.mcp.json` configuration — the agent gains access to new tools

The agent sees the instructions on startup and knows when and how to use the skill's tools.

---

## Assigning a Skill to an Agent

1. Open the **Executors → Agents** section
2. Open the card for the desired agent
3. In the **Skills** section, add the required skills
4. Save the changes
5. Restart the agent — the changes will take effect

---

## Editing a Skill

Click **Edit** in the skill card. Changes will apply on the next launch of agents using this skill.

## Deleting a Skill

Click **Delete**. The skill will disappear from the list, but for agents it was assigned to, it will remain in the `capabilities` list until manually removed.

---

## Skill Examples

| Skill | What it gives the agent |
|-------|-----------------|
| Yandex Tracker | Tools for working with tasks (creating, updating, commenting) |
| Bitrix24 | Working with leads, deals, contacts |
| Telegram | Sending messages to users via bot |
| GitHub | Working with issues, PRs, commits in a repository |
