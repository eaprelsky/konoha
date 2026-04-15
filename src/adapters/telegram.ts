// Telegram adapter for Konoha workflow runtime (KWE-008)
// Routes via naruto-tg-send.py (bot) for direct sends, or via Sasuke on Konoha bus

import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../logger";

const log = createLogger("telegram-adapter");

const execFileAsync = promisify(execFile);

const TG_SEND_SCRIPT = process.env.TG_SEND_SCRIPT || "/home/ubuntu/naruto-tg-send.py";

export interface Adapter {
  execute(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  healthcheck(): Promise<boolean>;
}

// Action: send_message
// input: { group_id, text }
// output: { message_id }
async function sendMessage(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { group_id, text } = input;
  if (!group_id) throw new Error("send_message: group_id is required");
  if (!text) throw new Error("send_message: text is required");

  const { stdout, stderr } = await execFileAsync("python3", [
    TG_SEND_SCRIPT,
    String(group_id),
    String(text),
  ]);

  if (stderr) log.warn("naruto-tg-send.py stderr", { stderr });

  // naruto-tg-send.py outputs the message_id on success, or an error string
  const output = stdout.trim();
  const message_id = parseInt(output);
  if (isNaN(message_id)) {
    throw new Error(`send_message: unexpected naruto-tg-send.py output: ${output}`);
  }

  return { message_id };
}

export const telegramAdapter: Adapter = {
  async execute(action, input) {
    switch (action) {
      case "send_message": return sendMessage(input);
      default: throw new Error(`telegram: unknown action "${action}"`);
    }
  },

  async healthcheck() {
    try {
      // naruto-tg-send.py exists and is executable
      await execFileAsync("python3", ["-c", `import importlib.util; assert importlib.util.find_spec('telethon') is not None`]);
      return true;
    } catch {
      return false;
    }
  },
};
