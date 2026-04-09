# Konoha Bus — MCP Integration

The Konoha MCP server provides Claude Code agents with tools to communicate through the bus without direct HTTP calls.

## Setup

Add to `.mcp.json` or Claude Code settings:

```json
{
  "mcpServers": {
    "konoha": {
      "command": "bun",
      "args": ["run", "--cwd", "/home/ubuntu/konoha", "src/mcp.ts"],
      "env": {
        "KONOHA_URL": "http://127.0.0.1:3200",
        "KONOHA_TOKEN": "your-secret-token"
      }
    }
  }
}
```

## Tools

### konoha_register

Register this agent on the bus. Automatically starts heartbeat every 5 minutes.

```
konoha_register(
  id: "naruto",
  name: "Naruto (Agent #1)",
  roles: ["orchestrator"],
  capabilities: ["orchestration", "telegram-bot", "code"]
)
```

### konoha_send

Send a message to another agent, a role group, or broadcast.

```
konoha_send(
  from: "naruto",
  to: "sasuke",          // or "all", or "role:monitor"
  text: "Hello!",
  type: "message",       // message | task | result | status | event
  channel: "ops",        // optional topic channel
  replyTo: "1774441021897-0"  // optional reply
)
```

### konoha_read

Read new (unacknowledged) messages. Messages are marked as read after retrieval.

```
konoha_read(agentId: "naruto", count: 10)
```

### konoha_agents

List registered agents with their status.

```
konoha_agents(onlineOnly: true)
```

Output:
```
🟢 naruto (Naruto (Agent #1)) — roles: orchestrator, caps: orchestration, telegram-bot, code
🟢 sasuke (Sasuke (Agent #2)) — roles: monitor, caps: telegram-monitor, telethon
⚫ itachi (Itachi) — roles: coder, assistant, caps: coding, analysis
```

### konoha_channels

List active topic channels.

```
konoha_channels()
```

### konoha_heartbeat

Manually send a heartbeat (useful if auto-heartbeat from registration isn't active).

```
konoha_heartbeat(agentId: "naruto")
```

### konoha_history

Read message history without acknowledging (non-destructive).

```
konoha_history(target: "naruto", count: 20)
konoha_history(target: "ops", count: 10)  // channel history
```

### konoha_listen

Block and listen for real-time messages via SSE. Returns all messages received during the listening period.

```
konoha_listen(agentId: "naruto", seconds: 30)
```

## Typical Agent Startup

```
1. konoha_register(id, name, roles, capabilities)
2. konoha_read(agentId) — check for pending messages
3. Start polling loop: konoha_read every 1 minute
4. konoha_heartbeat every 5 minutes (automatic if registered via MCP)
```

## Message Types

| Type | Use Case |
|------|----------|
| `message` | General communication |
| `task` | Task delegation |
| `result` | Task completion report |
| `status` | Status update |
| `event` | System event notification |

## Skill: testbench

TestBench is a persistent Chromium browser service with a Playwright pool for GUI testing.

**Activation**: Requires `skill=testbench` in `KONOHA_SKILLS` environment variable.

**Service**: `http://127.0.0.1:3201`

### Tools

#### konoha_testbench_navigate(url)
Open a page in Chromium.

**Parameters:**
- `url` (string, required) — full URL to navigate to (e.g., `http://127.0.0.1:3000/dashboard`)

**Returns:**
```json
{ "ok": true }
```

**Example:**
```
konoha_testbench_navigate(url="http://127.0.0.1:3000/dashboard")
```

#### konoha_testbench_action(type, selector?, text?, key?)
Execute an action on the current page.

**Parameters:**
- `type` (string, required) — action type: `click`, `type`, `scroll`, `hover`, `press`, `clear`
- `selector` (string, optional) — CSS selector for target element (required for click, hover)
- `text` (string, optional) — text to type (required for type action)
- `key` (string, optional) — keyboard key to press (required for press action, e.g., "Enter", "Escape", "Tab")

**Returns:**
```json
{ "ok": true }
```

**Examples:**
```
konoha_testbench_action(type="click", selector="button.submit")
konoha_testbench_action(type="type", text="test@example.com")
konoha_testbench_action(type="press", key="Enter")
konoha_testbench_action(type="hover", selector=".tooltip-trigger")
konoha_testbench_action(type="scroll")
konoha_testbench_action(type="clear", selector="input.search")
```

#### konoha_testbench_snapshot()
Capture the current page state: screenshot, accessibility tree, and element bounding boxes.

**Parameters:** none

**Returns:**
```json
{
  "screenshot_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "ariaSnapshot": "document:\\n  main\\n    h1 'Dashboard'\\n    button 'Settings'\\n    button 'Logout'",
  "bounding_boxes": {
    "button.submit": { "x": 100, "y": 200, "width": 80, "height": 40 },
    "input.email": { "x": 100, "y": 250, "width": 300, "height": 40 }
  }
}
```

**Example:**
```
konoha_testbench_snapshot()
// Use screenshot_base64 for visual comparison
// Use ariaSnapshot for accessibility assertions
// Use bounding_boxes for element positioning tests
```

#### konoha_testbench_resize(width, height)
Change the viewport size (useful for responsive testing).

**Parameters:**
- `width` (number, required) — viewport width in pixels
- `height` (number, required) — viewport height in pixels

**Returns:**
```json
{ "ok": true }
```

**Example:**
```
konoha_testbench_resize(width=1920, height=1080)  // Desktop
konoha_testbench_resize(width=375, height=667)   // Mobile
```

#### konoha_testbench_reset()
Reset the browser to a clean state: navigate to about:blank and clear cookies/localStorage/sessionStorage.

**Parameters:** none

**Returns:**
```json
{ "ok": true }
```

**Example:**
```
konoha_testbench_reset()
```

#### konoha_testbench_status()
Get the current status of the TestBench service and browser pool.

**Parameters:** none

**Returns:**
```json
{
  "poolSize": 5,
  "activeSessions": 2,
  "queueLength": 0,
  "currentURL": "http://127.0.0.1:3000/dashboard",
  "isReady": true
}
```

### Example: Full test workflow

```
// 1. Reset browser to clean state
konoha_testbench_reset()

// 2. Navigate to the page
konoha_testbench_navigate(url="http://127.0.0.1:3000/login")

// 3. Fill login form
konoha_testbench_action(type="click", selector="input[type=email]")
konoha_testbench_action(type="type", text="test@example.com")
konoha_testbench_action(type="click", selector="input[type=password]")
konoha_testbench_action(type="type", text="password123")

// 4. Submit form
konoha_testbench_action(type="click", selector="button[type=submit]")

// 5. Wait for navigation and take snapshot
// (in real scenario, add wait logic before snapshot)
konoha_testbench_snapshot()

// 6. Verify accessibility snapshot
// Assert: ariaSnapshot contains "main" with dashboard heading
// Assert: ariaSnapshot contains logout button
```

### Integration with Hinata

Hinata (Test Executor) uses TestBench tools for GUI testing:
- After Playwright E2E tests, use TestBench for visual regression and accessibility checks
- Combine `konoha_testbench_snapshot()` output with Playwright assertions
- Use `konoha_testbench_resize()` to test responsive design across device sizes
- Report TestBench results in test reports sent to Shino

### Notes

- Service runs on port 3201 (separate from Konoha bus port 3200)
- Browser pool maintains persistent sessions for fast test execution
- Screenshots are base64-encoded PNG images
- ARIA snapshot is machine-readable accessibility tree (compatible with Playwright's locatorHandleObjects)
- Bounding boxes are relative to viewport (0,0 at top-left)
