# Agents — User Guide

Agents are AI executors in Konoha. Each agent runs in a separate Claude Code session, has its own set of skills, and can receive tasks from processes.

---

## Viewing Agents

The **Executors → Agents** section shows all agents in the system.

For each agent, the following is displayed:
- Name and avatar
- Status: running / stopped / error
- Model (claude-sonnet-4-6, claude-haiku, etc.)
- Skills (list of connected capabilities)
- Uptime

---

## Creating an Agent

1. Click **Create Agent**
2. Fill in the fields:
   - **ID** — unique identifier (Latin characters, hyphens). Cannot be changed after creation
   - **Name** — display name (e.g., "Sales Assistant")
   - **Model** — select a Claude model. For complex tasks — Sonnet, for fast tasks — Haiku
   - **Instructions** — description of the agent's role, tasks, and behavioral rules
3. Click **Save**

The agent is created but not yet running.

---

## Assigning Skills

Skills extend an agent with tools (MCP servers) and instructions.

1. Open the agent card
2. In the **Skills** section, click **Add Skill**
3. Select the desired skills from the list
4. Click **Save**

Changes will take effect on the next agent start.

---

## Starting and Stopping

### Start an Agent

Click the **▶ Start** button on the agent card.

The system:
1. Creates the agent's working directory
2. Generates AGENTS.md (instructions + skills)
3. Generates .mcp.json (MCP tools)
4. Starts Claude Code in a tmux session
5. Sends the startup message

The status changes to **starting** → **running** (usually within 10–15 seconds).

### Stop an Agent

Click **■ Stop**. The agent will receive the `/exit` command and the session will end.

### Restart

Click **↺ Restart** — the agent will stop and immediately start again. Use this after changing instructions or skills.

---

## Uploading an Avatar

1. Open the agent card
2. Click on the avatar area (or the upload icon)
3. Select an image (JPG, PNG, up to 5 MB)

The avatar will appear on the agent card and in Konoha bus messages.

---

## Editing an Agent

Click **Edit** on the agent card. You can change:
- Name
- Model
- Instructions (system prompt)
- Skills

After saving, click **Restart** to apply the changes.

---

## System Agents

Agents tagged as **system** (Naruto, Sasuke, Kakashi, Mirai) cannot be deleted through the interface. Starting and stopping them requires confirmation.

---

## Viewing Agent Memory

The agent card has a **Memory** tab — a list of files in the agent's memory directory (`/opt/shared/agent-memory/{id}/`). Files can be viewed and edited directly in the interface.
