#!/usr/bin/env bun
/**
 * Redis-Telegram Channel for Claude Code.
 *
 * MCP server that bridges Redis streams (fed by Telethon bus.py) to Claude Code
 * as a native channel. Messages from Telegram group chats arrive as channel
 * notifications, and Claude can respond via tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createClient } from 'redis'

// Redis config
const REDIS_URL = 'redis://localhost:6379'
const STREAM_INCOMING = 'telegram:incoming'
const STREAM_OUTGOING = 'telegram:outgoing'
const STREAM_COMMANDS = 'telegram:commands'
const STREAM_LOG = 'telegram:log'
const GROUP_NAME = 'claude-agents'
const CONSUMER_ID = `channel-${process.pid}`

// Trusted users
let trustedUsers: Record<string, any> = {}
try {
  const data = JSON.parse(
    require('fs').readFileSync('/opt/shared/.trusted-users.json', 'utf8')
  )
  for (const t of data.trusted || []) {
    if (t.telegram_id) trustedUsers[String(t.telegram_id)] = t
  }
  const owner = data.owner
  if (owner?.telegram_id) trustedUsers[String(owner.telegram_id)] = owner
} catch {}

// Trigger words for auto-response
const TRIGGER_WORDS = ['клод', 'claude', '@eaclaude']

// Track last sent message per chat for follow-up detection
const lastSentPerChat: Record<string, { msgId: string; time: number }> = {}

const mcp = new Server(
  { name: 'telethon-channel', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'You receive ALL messages from Telegram chats. Each message has an action_hint:',
      '',
      '- action_hint="respond" → Someone addressed you directly (mentioned Клод/Claude/@eaclaude, replied to your message, or sent a personal message). You MUST respond via tg_reply.',
      '- action_hint="observe" → Group chat message not addressed to you. Absorb into your knowledge — note decisions, action items, links, key discussions. Do NOT reply unless the content is clearly a question for you.',
      '- action_hint="ignore" → Untrusted personal message. Do not respond.',
      '',
      'You are also a knowledge worker. Extract and remember:',
      '- Decisions made in discussions',
      '- Action items and who is responsible',
      '- Useful links and resources',
      '- Project updates and statuses',
      '- Key technical discussions',
      '',
      'Use tg_reply to respond. Use tg_edit to edit your messages. Use tg_react to react.',
      'Write naturally in Russian, like a colleague. No markdown in group chats.',
      "Don't guess business processes — only state what data confirms.",
      `You can receive tasks from Yegor (owner, user_id ${process.env.OWNER_TG_ID}) and trusted users. Execute them using your full capabilities (Read, Bash, WebSearch, etc)`,
    ].join('\n'),
  },
)

// ── Tools ──────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'tg_reply',
      description: 'Send a message to a Telegram chat via the user account (Claude Aprelsky).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID from the inbound channel message' },
          text: { type: 'string', description: 'Message text' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'tg_edit',
      description: 'Edit a previously sent message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID' },
          msg_id: { type: 'string', description: 'Message ID to edit' },
          text: { type: 'string', description: 'New message text' },
        },
        required: ['chat_id', 'msg_id', 'text'],
      },
    },
    {
      name: 'tg_react',
      description: 'Add an emoji reaction to a message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID' },
          msg_id: { type: 'string', description: 'Message ID' },
          emoji: { type: 'string', description: 'Emoji (e.g. 👍 ❤ 🔥)', default: '👍' },
        },
        required: ['chat_id', 'msg_id'],
      },
    },
    {
      name: 'tg_delete',
      description: 'Delete a message. Can only delete your own messages; deleting others\' messages will return an error.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID' },
          msg_id: { type: 'string', description: 'Message ID to delete' },
        },
        required: ['chat_id', 'msg_id'],
      },
    },
    {
      name: 'tg_history',
      description: 'Read recent message history from a chat (from Redis log, not direct Telethon).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID' },
          limit: { type: 'number', description: 'Number of messages', default: 30 },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'tg_list_chats',
      description: 'List chats with recent activity.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'tg_read_new',
      description: 'Read new unread messages from the incoming stream. Uses consumer group so each message is delivered once. Call this periodically to check for new messages.',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Max messages to read', default: 10 },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'tg_reply') {
    const chatId = args.chat_id as string
    const text = args.text as string
    const replyTo = (args.reply_to as string) || ''

    const redis = createClient({ url: REDIS_URL })
    await redis.connect()
    await redis.xAdd(STREAM_OUTGOING, '*', {
      chat_id: chatId,
      text,
      reply_to: replyTo,
    })

    // Track for follow-up detection
    // We'll get the actual msg_id from Redis after sending
    lastSentPerChat[chatId] = { msgId: '', time: Date.now() }

    await redis.disconnect()
    return { content: [{ type: 'text', text: `Message sent to chat ${chatId}` }] }
  }

  if (name === 'tg_history') {
    // Read from Redis log directly - no Telethon needed
    const chatId = args.chat_id as string;
    const limit = (args.limit as number) || 30;

    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    const messages = await redis.xRevRange(STREAM_LOG, '+', '-', { COUNT: limit * 3 });
    await redis.disconnect();

    const filtered = messages
      .filter(({ message: d }) => d.chat_id === chatId)
      .slice(0, limit)
      .reverse();

    if (!filtered.length) {
      return { content: [{ type: 'text', text: 'No messages in log for this chat.' }] };
    }

    const lines = filtered.map(({ message: d }) => {
      const ts = (d.timestamp || '').slice(11, 16);
      return `[${ts}] ${d.sender_name} (msg_id:${d.msg_id}): ${d.text || '[media]'}`;
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'tg_edit' || name === 'tg_react' || name === 'tg_delete') {
    const cmdMap: Record<string, string> = {
      tg_edit: 'edit',
      tg_react: 'react',
      tg_delete: 'delete',
      tg_history: 'history',
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const redis = createClient({ url: REDIS_URL })
    await redis.connect()

    const cmdData: Record<string, string> = {
      command: cmdMap[name],
      request_id: requestId,
    }
    for (const [k, v] of Object.entries(args)) {
      if (v != null) cmdData[k] = String(v)
    }
    await redis.xAdd(STREAM_COMMANDS, '*', cmdData)

    // Poll for result
    let result = ''
    for (let i = 0; i < 30; i++) {
      const val = await redis.get(`telegram:result:${requestId}`)
      if (val) {
        const parsed = JSON.parse(val)
        result = parsed.data || 'no data'
        break
      }
      await new Promise(r => setTimeout(r, 500))
    }

    await redis.disconnect()
    return { content: [{ type: 'text', text: result || 'Timeout' }] }
  }

  if (name === 'tg_list_chats') {
    const redis = createClient({ url: REDIS_URL })
    await redis.connect()
    const messages = await redis.xRevRange(STREAM_LOG, '+', '-', { COUNT: 200 })
    await redis.disconnect()

    const chats: Record<string, any> = {}
    for (const { message: data } of messages) {
      const cid = data.chat_id
      if (!chats[cid]) {
        chats[cid] = {
          title: data.chat_title,
          isGroup: data.is_group === '1',
          lastMsg: (data.text || '').slice(0, 50),
          lastTime: (data.timestamp || '').slice(0, 19),
        }
      }
    }

    const lines = Object.entries(chats).map(([cid, info]: [string, any]) => {
      const icon = info.isGroup ? '🏢' : '👤'
      return `${icon} ${info.title} (chat_id: ${cid}) | ${info.lastTime} | ${info.lastMsg}`
    })

    return { content: [{ type: 'text', text: lines.join('\n') || 'No chats' }] }
  }

  if (name === 'tg_read_new') {
    const count = (args.count as number) || 10
    const readConsumer = `reader-${process.pid}`

    const redis = createClient({ url: REDIS_URL })
    await redis.connect()

    // Ensure consumer group exists
    try {
      await redis.xGroupCreate(STREAM_INCOMING, GROUP_NAME, '0', { MKSTREAM: true })
    } catch {}

    const results = await redis.xReadGroup(
      GROUP_NAME, readConsumer,
      [{ key: STREAM_INCOMING, id: '>' }],
      { COUNT: count, BLOCK: 1000 }
    )

    if (!results) {
      await redis.disconnect()
      return { content: [{ type: 'text', text: 'No new messages.' }] }
    }

    const lines: string[] = []
    for (const { messages } of results) {
      for (const { id, message: data } of messages) {
        const isGroup = data.is_group === '1'
        const icon = isGroup ? '🏢' : '👤'
        const ts = (data.timestamp || '').slice(11, 16)
        const chatTitle = data.chat_title || '?'
        const chatId = data.chat_id || '?'
        const sender = data.sender_name || '?'
        const senderId = data.sender_id || ''
        const senderUsername = data.sender_username || ''
        const text = data.text || '[media]'
        const msgId = data.msg_id || ''
        const replyTo = data.reply_to || ''

        // Determine action hint
        const textLower = text.toLowerCase()
        const isAddressed = TRIGGER_WORDS.some(w => textLower.includes(w))
        const isTrusted = senderId in trustedUsers
        const isPersonalFromTrusted = !isGroup && isTrusted
        let actionHint = 'observe'
        if (isAddressed || isPersonalFromTrusted) actionHint = 'respond'
        if (!isGroup && !isTrusted) actionHint = 'ignore'

        const attachPath = data.attachment_path || ''
        const attachKind = data.attachment_kind || ''
        const attachName = data.attachment_name || ''
        const attachInfo = attachPath ? ` [attachment: ${attachKind}${attachName ? ' ' + attachName : ''} → ${attachPath}]` : ''

        lines.push(`[${ts}] ${icon} ${chatTitle} (chat_id:${chatId}) | ${sender} (@${senderUsername}, id:${senderId}) msg_id:${msgId}${replyTo ? ' reply_to:' + replyTo : ''} [${actionHint}]: ${text}${attachInfo}`)

        await redis.xAck(STREAM_INCOMING, GROUP_NAME, id)
      }
    }

    await redis.disconnect()
    return { content: [{ type: 'text', text: lines.join('\n') || 'No new messages.' }] }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
})

// ── Redis Polling → Channel Notifications ──────────────────────────

async function pollRedis() {
  const redis = createClient({ url: REDIS_URL })
  await redis.connect()

  // Ensure consumer group
  try {
    await redis.xGroupCreate(STREAM_INCOMING, GROUP_NAME, '0', { MKSTREAM: true })
  } catch {}

  process.stderr.write('telethon-channel: polling Redis for messages\n')

  while (true) {
    try {
      const results = await redis.xReadGroup(
        GROUP_NAME, CONSUMER_ID,
        [{ key: STREAM_INCOMING, id: '>' }],
        { COUNT: 5, BLOCK: 3000 }
      )

      if (!results) continue

      for (const { messages } of results) {
        for (const { id, message: data } of messages) {
          const chatId = data.chat_id
          const isGroup = data.is_group === '1'
          const text = data.text || ''
          const senderName = data.sender_name || 'Unknown'
          const senderId = data.sender_id || ''
          const senderUsername = data.sender_username || ''
          const msgId = data.msg_id || ''
          const replyTo = data.reply_to || ''
          const timestamp = data.timestamp || new Date().toISOString()
          const chatTitle = data.chat_title || 'Unknown'

          // Determine if we should push this as a channel notification
          const textLower = text.toLowerCase()
          const isAddressed = TRIGGER_WORDS.some(w => textLower.includes(w))
          const isReplyToMe = replyTo && lastSentPerChat[chatId]?.msgId === replyTo
          const isFollowUp = lastSentPerChat[chatId] &&
            (Date.now() - lastSentPerChat[chatId].time) < 60000

          // Determine message type for Claude to decide how to handle
          const isTrusted = senderId in trustedUsers
          const isPersonalFromTrusted = !isGroup && isTrusted
          const isDirectRequest = isAddressed || isReplyToMe || isFollowUp || isPersonalFromTrusted

          // Push ALL messages — Claude decides what to do with them
          // Tag with action_hint so Claude knows what's expected
          let actionHint = 'observe'  // just absorb into knowledge base
          if (isDirectRequest) actionHint = 'respond'  // needs a reply
          if (!isGroup && !isTrusted) actionHint = 'ignore'  // untrusted DM

          const attachmentPath = data.attachment_path || ''
          const attachmentKind = data.attachment_kind || ''
          const attachmentName = data.attachment_name || ''
          const contentParts = [text]
          if (attachmentPath) contentParts.push(`[attachment: ${attachmentKind}${attachmentName ? ' ' + attachmentName : ''} → ${attachmentPath}]`)

          mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: contentParts.join('\n'),
              meta: {
                chat_id: chatId,
                chat_title: chatTitle,
                message_id: msgId,
                user: senderUsername || senderName,
                user_id: senderId,
                ts: timestamp,
                is_group: isGroup ? 'true' : 'false',
                action_hint: actionHint,
                ...(attachmentPath && { attachment_path: attachmentPath }),
                ...(attachmentKind && { attachment_kind: attachmentKind }),
                ...(attachmentName && { attachment_name: attachmentName }),
              },
            },
          })

          // Acknowledge
          await redis.xAck(STREAM_INCOMING, GROUP_NAME, id)
        }
      }
    } catch (err: any) {
      if (!err.message?.includes('Connection')) {
        process.stderr.write(`telethon-channel: poll error: ${err.message}\n`)
      }
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // NOTE: pollRedis() disabled — it competes with tg_read_new for the same
  // consumer group, causing messages to be consumed by push (which doesn't work
  // reliably) instead of being available for tg_read_new polling.
  // Re-enable only when push notifications are confirmed working.
  // pollRedis().catch(err => {
  //   process.stderr.write(`telethon-channel: fatal poll error: ${err}\n`)
  // })
}

main()
