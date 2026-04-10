# Information Systems (IS) — User Guide

The **System → IS** section displays external systems connected to Konoha. These systems are used in process events: triggers arrive through them and actions are sent back out.

---

## What is an Information System in Konoha

In an eEPC diagram, the **IS** element represents an external system that a process interacts with. Examples: Bitrix24 CRM, Telegram messenger, task tracker.

At the engine level, each IS is implemented as an **adapter** — a component that can:
- Listen for incoming events from the system (e.g., a new lead in Bitrix)
- Query data for conditional triggers (e.g., the number of open tasks)

---

## Available Information Systems

| System | Capabilities |
|---------|-----------|
| **Bitrix24** | Receive events for leads, deals, and tasks; query the number of CRM records |
| **Telegram** | Receive messages from users via bot |
| **Yandex Tracker** | Receive events for tasks and comments; query the number of tasks in a queue |

---

## Viewing Status

On the **System → IS** page, the following is shown for each system:
- Name and type
- **Connection status**: connected / error / not checked
- Time of the last successful check
- Last error message (if any)
- Number of active listeners (processes waiting for events from this system)

---

## Checking the Connection

Click **Check** next to the relevant system. Konoha will send a test request to the system and update the status.

- Green — the system is reachable, tokens are valid
- Red — the system is unreachable or there is an authorization error

---

## Connection Configuration

Credentials for connecting to external systems are stored in a configuration file on the server (`/opt/shared/.shared-credentials`) and are set by the administrator. They cannot be changed through the interface.

If a system shows a connection error, contact the administrator to verify tokens and webhook addresses.

---

## Using IS in Processes

In the process editor, the **IS** element on the diagram visually indicates which system a given step interacts with. When a process is saved, Trigger Resolver automatically determines the event type from the label text and links it to the appropriate IS.

Example: if a process contains the event "Lead added in Bitrix24", Trigger Resolver classifies it as a `message` with `source=bitrix`, and when the process is deployed, Event Manager activates a listener on the Bitrix24 adapter.
