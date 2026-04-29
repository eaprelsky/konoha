import Anthropic from "@anthropic-ai/sdk";
import { config, requireConfig, type LlmProvider } from "./config";
import { ConfigError, ExternalServiceError } from "./errors";

export type LlmContent = string | Anthropic.MessageParam["content"];

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContent;
}

export interface GenerateTextParams {
  system?: string;
  messages: LlmMessage[];
  model: string;
  maxTokens: number;
  temperature?: number;
}

function getProvider(): LlmProvider {
  return config.llm.provider;
}

async function generateAnthropicText(params: GenerateTextParams): Promise<string> {
  const client = new Anthropic({ apiKey: requireConfig("ANTHROPIC_API_KEY", config.llm.anthropicApiKey) });
  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.system ? { system: params.system } : {}),
    messages: params.messages,
  });
  return ((response.content[0] as any)?.text ?? "").trim();
}

function contentToText(content: LlmContent): string {
  if (typeof content === "string") return content;
  return content
    .map(block => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image]";
      if (block.type === "document") return "[document]";
      if (block.type === "search_result") return block.title ?? block.source ?? "[search_result]";
      return `[${block.type}]`;
    })
    .join("\n");
}

async function generateGlmText(params: GenerateTextParams): Promise<string> {
  const apiKey = requireConfig("GLM_API_KEY", config.llm.glmApiKey);
  const response = await fetch(`${config.llm.glmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      messages: [
        ...(params.system ? [{ role: "system", content: params.system }] : []),
        ...params.messages.map(message => ({
          ...message,
          content: contentToText(message.content),
        })),
      ],
    }),
  });

  if (!response.ok) {
    throw new ExternalServiceError("GLM request failed", { status: response.status });
  }

  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function generateText(params: GenerateTextParams): Promise<string> {
  const provider = getProvider();
  if (provider === "glm") return generateGlmText(params);
  if (provider === "anthropic") return generateAnthropicText(params);
  throw new ConfigError(`Unsupported LLM provider: ${provider}`, { provider });
}
