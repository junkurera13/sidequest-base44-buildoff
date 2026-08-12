import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent, defineDynamic } from "eve";
import type { ModelMessage } from "ai";

const MEMORY_MODEL_ID = "moonshotai/kimi-k2.6";
const CONVERSATION_MODEL_ID = "deepseek/deepseek-v4-flash";
const openrouter = createOpenRouter({
  compatibility: "strict",
  appName: "Chapter",
  appUrl: "https://chapter-buildoff.vercel.app",
  extraBody: {
    provider: {
      allow_fallbacks: true,
      data_collection: "deny",
      require_parameters: true,
      zdr: true,
    },
  },
});
const memoryModel = openrouter(MEMORY_MODEL_ID);
const conversationModel = openrouter(CONVERSATION_MODEL_ID);

function includesImage(messages: readonly ModelMessage[]) {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "image" ||
          (part.type === "file" && part.mediaType.startsWith("image/")),
      ),
  );
}

export default defineAgent({
  model: defineDynamic({
    fallback: memoryModel,
    events: {
      "step.started": (_event, ctx) => {
        const isMemory =
          ctx.session.auth.initiator?.attributes.channel === "memory" ||
          includesImage(ctx.messages);
        return {
          model: isMemory ? memoryModel : conversationModel,
          modelContextWindowTokens: isMemory ? 262_000 : 1_000_000,
        };
      },
    },
  }),
  modelContextWindowTokens: 262_000,
  reasoning: "provider-default",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 20_000,
  },
});
