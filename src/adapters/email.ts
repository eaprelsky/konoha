// Email adapter for Konoha workflow runtime (KWE-009)
// Sends emails via SMTP (mail.eaprelsky.ru:587, STARTTLS)
// Action: send_email — input: {to, subject, template, data}, output: {message_id}

import nodemailer from "nodemailer";
import type { Adapter } from "./bitrix24";

const SMTP_HOST = process.env.CHATBOT_SMTP_HOST || "mail.eaprelsky.ru";
const SMTP_PORT = parseInt(process.env.CHATBOT_SMTP_PORT || "587");
const SMTP_USER = process.env.CHATBOT_SMTP_USER || "";
const SMTP_PASSWORD = process.env.CHATBOT_SMTP_PASSWORD || "";

if (!SMTP_USER || !SMTP_PASSWORD) {
  console.warn("[email-adapter] CHATBOT_SMTP_USER / CHATBOT_SMTP_PASSWORD not set — adapter will fail at runtime");
}

function createTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false, // STARTTLS (upgrades after connect)
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASSWORD,
    },
  });
}

// Simple {{variable}} template substitution
function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = data[key];
    return val !== undefined && val !== null ? String(val) : `{{${key}}}`;
  });
}

// Action: send_email
// input: { to, subject, template, data }
// output: { message_id }
async function sendEmail(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { to, subject, template, data } = input;

  if (!to) throw new Error("send_email: 'to' is required");
  if (!subject) throw new Error("send_email: 'subject' is required");
  if (!template || typeof template !== "string") throw new Error("send_email: 'template' must be a non-empty string");

  const templateData = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const body = renderTemplate(template, templateData);
  const renderedSubject = renderTemplate(String(subject), templateData);

  const transport = createTransport();
  const info = await transport.sendMail({
    from: SMTP_USER,
    to: String(to),
    subject: renderedSubject,
    text: body,
  });

  return { message_id: info.messageId };
}

export const emailAdapter: Adapter = {
  async execute(action, input) {
    switch (action) {
      case "send_email": return sendEmail(input);
      default: throw new Error(`email: unknown action "${action}"`);
    }
  },

  async healthcheck() {
    if (!SMTP_USER || !SMTP_PASSWORD) return false;
    try {
      const transport = createTransport();
      await Promise.race([
        transport.verify(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      return true;
    } catch {
      return false;
    }
  },
};
