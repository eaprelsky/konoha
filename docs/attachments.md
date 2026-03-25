# Konoha Bus — File Attachments

Konoha supports inter-agent file exchange through shared storage and attachment metadata in messages.

## How It Works

```
Agent A                  Konoha Bus                Agent B
  │                         │                         │
  │  1. Upload file         │                         │
  │  POST /attachments ────►│                         │
  │  ◄── {path, name, ...}  │                         │
  │                         │                         │
  │  2. Send message        │                         │
  │  with attachment path   │                         │
  │  POST /messages ───────►│  3. Deliver to Agent B  │
  │                         │────────────────────────►│
  │                         │                         │
  │                         │     4. Read file from   │
  │                         │        shared storage   │
  │                         │        /opt/shared/     │
  │                         │        attachments/     │
```

## Shared Storage

All files are stored in `/opt/shared/attachments/`. This directory is accessible to all agents on the machine.

Files are named: `{from}-{timestamp}{extension}` (e.g., `naruto-1774441029710.pdf`)

## Upload a File

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -F "file=@document.pdf" \
  -F "from=naruto" \
  http://127.0.0.1:3200/attachments
```

Response (201):
```json
{
  "attachment": {
    "name": "document.pdf",
    "path": "/opt/shared/attachments/naruto-1774441029710.pdf",
    "mime": "application/pdf",
    "size": 245760
  }
}
```

## Send a Message with Attachments

After uploading (or if the file is already in shared storage):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "naruto",
    "to": "sasuke",
    "text": "Here is the report",
    "attachments": [
      {
        "name": "document.pdf",
        "path": "/opt/shared/attachments/naruto-1774441029710.pdf",
        "mime": "application/pdf"
      }
    ]
  }' \
  http://127.0.0.1:3200/messages
```

You can also reference files already in shared storage without uploading:

```bash
# File was downloaded by telegram-bot-service
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "naruto",
    "to": "sasuke",
    "text": "Photo from Yegor",
    "attachments": [
      {
        "name": "photo.jpg",
        "path": "/opt/shared/attachments/1774441389587-photo-1774441389587.jpg",
        "mime": "image/jpeg"
      }
    ]
  }' \
  http://127.0.0.1:3200/messages
```

## Attachment Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Original filename |
| path | string | yes | Absolute path in shared storage |
| mime | string | no | MIME type (e.g., `image/jpeg`, `application/pdf`) |
| size | number | no | File size in bytes (auto-detected if omitted) |

Path validation: the server checks that `path` exists on disk before including it in the message. Invalid paths are silently dropped.

## Integration with Telegram

The [telegram-bot-service](https://github.com/eaprelsky/telegram-bot-service) automatically downloads files from Telegram users into `/opt/shared/attachments/`:

- **Photos** — downloaded as `.jpg`
- **Documents** — downloaded with original filename/extension
- **Voice messages** — downloaded as `.ogg`
- **Audio** — downloaded with original extension

The downloaded file path appears in the Redis stream `telegram:bot:incoming` as `attachment_path`.

## Supported File Types

Any file type is supported. Common use cases:

| Type | Extensions | Use Case |
|------|-----------|----------|
| Images | .jpg, .png, .gif, .webp | Screenshots, photos, diagrams |
| Documents | .pdf, .docx, .xlsx | Reports, contracts, spreadsheets |
| Audio | .ogg, .mp3, .wav | Voice messages, recordings |
| Code | .py, .ts, .json | Config files, scripts |
| Archives | .zip, .tar.gz | Bundled deliverables |
