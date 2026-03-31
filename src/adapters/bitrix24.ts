// Bitrix24 adapter for Konoha workflow runtime (KWE-007)
// Uses CHATBOT_BITRIX_WEBHOOK from /opt/shared/.shared-credentials

const WEBHOOK_URL = process.env.CHATBOT_BITRIX_WEBHOOK || "";

if (!WEBHOOK_URL) {
  console.warn("[bitrix24] CHATBOT_BITRIX_WEBHOOK not set — adapter will fail at runtime");
}

export interface Adapter {
  execute(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  healthcheck(): Promise<boolean>;
}

async function callBitrix(method: string, params: Record<string, unknown>): Promise<any> {
  if (!WEBHOOK_URL) throw new Error("CHATBOT_BITRIX_WEBHOOK is not configured");

  const url = WEBHOOK_URL.replace(/\/$/, "") + "/" + method + ".json";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bitrix24 API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Bitrix24 error: ${data.error_description || data.error}`);
  return data.result;
}

// Action: create_lead
// input: { name, company?, email?, phone?, source? }
// output: { lead_id }
async function createLead(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {
    TITLE: input.name || "New Lead",
  };
  if (input.company) fields.COMPANY_TITLE = input.company;
  if (input.email) fields.EMAIL = [{ VALUE: input.email, VALUE_TYPE: "WORK" }];
  if (input.phone) fields.PHONE = [{ VALUE: input.phone, VALUE_TYPE: "WORK" }];
  if (input.source) fields.SOURCE_ID = input.source;

  const result = await callBitrix("crm.lead.add", { fields });
  return { lead_id: result };
}

// Action: update_lead
// input: { lead_id, ...fields }
// output: { updated: true }
async function updateLead(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { lead_id, ...rest } = input;
  if (!lead_id) throw new Error("update_lead: lead_id is required");

  const fields: Record<string, unknown> = {};
  if (rest.name) fields.TITLE = rest.name;
  if (rest.company) fields.COMPANY_TITLE = rest.company;
  if (rest.email) fields.EMAIL = [{ VALUE: rest.email, VALUE_TYPE: "WORK" }];
  if (rest.phone) fields.PHONE = [{ VALUE: rest.phone, VALUE_TYPE: "WORK" }];
  if (rest.status_id) fields.STATUS_ID = rest.status_id;
  // Pass through any other CRM fields prefixed with CRM_
  for (const [k, v] of Object.entries(rest)) {
    if (k.startsWith("CRM_")) fields[k.slice(4)] = v;
  }

  await callBitrix("crm.lead.update", { id: lead_id, fields });
  return { updated: true, lead_id };
}

export const bitrix24Adapter: Adapter = {
  async execute(action, input) {
    switch (action) {
      case "create_lead": return createLead(input);
      case "update_lead": return updateLead(input);
      default: throw new Error(`bitrix24: unknown action "${action}"`);
    }
  },

  async healthcheck() {
    try {
      await callBitrix("app.info", {});
      return true;
    } catch {
      return false;
    }
  },
};
