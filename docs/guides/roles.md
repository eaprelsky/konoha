# Roles — User Guide

A role is an abstract executor in an eEPC process. Roles are not bound directly to specific people or agents — instead, a role has a list of **assignees** who will be assigned to tasks within the process.

---

## Viewing Roles

The **Executors → Roles** section shows all roles in the system.

For each role the following is displayed:
- Name and description
- List of assignees (people or agents)
- Assignment strategy

---

## Creating a Role

1. Click **Create role**
2. Fill in the fields:
   - **Role ID** — unique identifier (Latin characters, hyphens, e.g. `sales-manager`)
   - **Name** — human-readable name (e.g., "Sales Manager")
   - **Description** — optional description of responsibilities
3. Click **Save**

---

## Role Assignees

After creating a role, add assignees — people or AI agents who will perform tasks for this role.

1. Open the role card
2. In the **Assignees** section, click **Add**
3. Select an employee from the people directory or an agent

There can be multiple assignees.

---

## Assignment Strategy

Determines how a task is distributed among multiple assignees:

| Strategy | Description |
|-----------|----------|
| `manual` | Task is assigned manually on each run |
| `round_robin` | Tasks are distributed in turn among assignees |
| `first_available` | Task goes to the first available assignee |

The strategy can be changed in the role settings.

---

## Using Roles in Processes

In the eEPC editor, the **Role** element (lane) is linked to a specific role from the directory. When a run is started, the system looks at the assignment strategy and determines which assignee will receive the task.

---

## Editing a Role

Click **Edit** in the role card. You can change the name, description, list of assignees, and strategy.

## Deleting a Role

Click **Delete** in the role card. The role will be removed from the directory, but will not disappear from already-created processes — it will remain there as an unlinked element.
