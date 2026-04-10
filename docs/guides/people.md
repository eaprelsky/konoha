# People — User Guide

The people directory contains profiles of employees and process participants. People can be assigned as role executors and appear in process tasks.

---

## Viewing the Directory

The **Executors → People** section shows all participants in the system.

For each person the following is displayed:
- Name and position
- Avatar
- Contacts (Telegram, email)
- Source: **system** (from the configuration file) or **manually added**

---

## Two Types of Records

**System** — loaded from the `/opt/shared/.trusted-users.json` file. These are employees who are granted access to the system. They cannot be deleted through the interface — changes are made to the file by an administrator.

**User-created** — added manually through the interface. Can be created, edited, and deleted.

---

## Adding a Person

1. Click **Add person**
2. Fill in the fields:
   - **Name** — required field
   - **Position** — role in the organization
   - **Telegram ID** — numeric ID in Telegram (needed for notifications)
   - **Telegram @username** — username
   - **Email** — address for email notifications
3. Optionally, you can specify IDs in integrated systems:
   - **Bitrix24 ID** — for linking to CRM
   - **Yandex Tracker login** — for task assignment
   - **Yonote ID** — for working with the knowledge base
4. Click **Save**

---

## Uploading an Avatar

1. Open the person's card
2. Click on the avatar or the upload icon
3. Select an image (JPG, PNG)

---

## Notification Channel

In the **Channel** field, select how the system will contact this person when a task is assigned:
- `telegram` — notification via Telegram bot
- `email` — notification by email

---

## Deletion

Only user-created records can be deleted (the **Delete** button in the card). System records are protected from deletion.
