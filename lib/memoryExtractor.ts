import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  generateText,
  Output,
  type UserContent,
} from "ai";

import {
  memoryExtractionSchema,
  type MemoryExtraction,
} from "./memoryExtractionSchema";

const PRIMARY_MEMORY_MODEL_ID =
  process.env.CHAPTER_MEMORY_MODEL || "google/gemini-3.1-flash-lite";
const FALLBACK_MEMORY_MODEL_ID =
  process.env.CHAPTER_MEMORY_FALLBACK_MODEL || "moonshotai/kimi-k2.6";

/**
 * How the extraction budget is spent.
 *
 * Measured against four photos: the primary model answers in 6 to 13 seconds
 * when it answers at all, and returns nothing about a third of the time. That
 * failure is transient, so asking it again is worth far more than handing the
 * memory straight to the slower fallback, which needs well over 35 seconds and
 * sometimes never finishes. Three primary tries put the odds of losing a memory
 * to that flakiness in the low single digits, and the fallback is still there
 * for the case where the primary is genuinely down.
 */
const PRIMARY_ATTEMPT_TIMEOUT_MS = 25_000;
const FALLBACK_ATTEMPT_TIMEOUT_MS = 40_000;
/** Kept under the route's 120s ceiling with room for the Base44 round trips. */
const TOTAL_EXTRACTION_BUDGET_MS = 90_000;
/** Below this there is not enough time left for an answer worth waiting for. */
const MIN_ATTEMPT_MS = 6_000;
const RETRY_PAUSE_MS = 400;
const MAX_OUTPUT_TOKENS = 16_000;

export function extractionAttempts() {
  return [
    { modelId: PRIMARY_MEMORY_MODEL_ID, timeoutMs: PRIMARY_ATTEMPT_TIMEOUT_MS },
    { modelId: PRIMARY_MEMORY_MODEL_ID, timeoutMs: PRIMARY_ATTEMPT_TIMEOUT_MS },
    { modelId: PRIMARY_MEMORY_MODEL_ID, timeoutMs: PRIMARY_ATTEMPT_TIMEOUT_MS },
    {
      modelId: FALLBACK_MEMORY_MODEL_ID,
      timeoutMs: FALLBACK_ATTEMPT_TIMEOUT_MS,
    },
  ];
}

export const extractionBudget = {
  totalMs: TOTAL_EXTRACTION_BUDGET_MS,
  minAttemptMs: MIN_ATTEMPT_MS,
};

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
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

type MemoryAttachment = {
  url: string;
  fileName: string;
  mediaType: string;
};

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeTimeout(error: unknown) {
  return (
    /timeout|timed out|abort/i.test(errorName(error)) ||
    /timeout|timed out|abort/i.test(errorMessage(error))
  );
}

export class MemoryExtractionUnavailableError extends Error {
  constructor(readonly timedOut: boolean) {
    super(
      timedOut
        ? "Memory extraction reached its time limit."
        : "Memory extraction did not return a valid graph.",
    );
    this.name = "MemoryExtractionUnavailableError";
  }
}

export async function extractMemory(args: {
  prompt: string;
  attachments: MemoryAttachment[];
  requestId: string;
  signal?: AbortSignal;
}): Promise<MemoryExtraction> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const message: UserContent = [
    { type: "text", text: args.prompt },
    ...args.attachments.map((attachment) => ({
      type: "file" as const,
      data: new URL(attachment.url),
      mediaType: attachment.mediaType,
      filename: attachment.fileName,
    })),
  ];
  const attempts = extractionAttempts();
  const deadline = Date.now() + TOTAL_EXTRACTION_BUDGET_MS;
  let timedOut = false;

  for (const [attempt, { modelId, timeoutMs }] of attempts.entries()) {
    if (args.signal?.aborted) {
      throw new MemoryExtractionUnavailableError(true);
    }

    // Never let the ladder outlive the request that is waiting on it.
    const remainingMs = deadline - Date.now();
    if (remainingMs < MIN_ATTEMPT_MS) {
      timedOut = true;
      console.warn("[memory:extract] budget spent", {
        requestId: args.requestId,
        skippedFromAttempt: attempt + 1,
        remainingMs,
      });
      break;
    }

    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }

    const attemptTimeoutMs = Math.min(timeoutMs, deadline - Date.now());
    const startedAt = Date.now();
    console.info("[memory:extract] attempt started", {
      requestId: args.requestId,
      attempt: attempt + 1,
      of: attempts.length,
      model: modelId,
      timeoutMs: attemptTimeoutMs,
      imageCount: args.attachments.length,
    });

    try {
      const result = await generateText({
        model: openrouter(modelId),
        messages: [{ role: "user", content: message }],
        output: Output.object({
          name: "chapter_memory_graph",
          description:
            "A grounded memory graph with one experience node and separate specific people, places, activities, interests, feelings, conditions, and patterns.",
          schema: memoryExtractionSchema,
        }),
        reasoning: "none",
        temperature: 0.1,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        timeout: { totalMs: attemptTimeoutMs },
        abortSignal: args.signal,
      });
      const extraction = memoryExtractionSchema.parse(result.output);
      console.info("[memory:extract] attempt completed", {
        requestId: args.requestId,
        attempt: attempt + 1,
        model: modelId,
        elapsedMs: Date.now() - startedAt,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return extraction;
    } catch (error) {
      timedOut ||= looksLikeTimeout(error);
      // The primary's failure carries no cause, so record the message too:
      // the name alone cannot tell an empty answer from a refusal.
      console.warn("[memory:extract] attempt failed", {
        requestId: args.requestId,
        attempt: attempt + 1,
        model: modelId,
        elapsedMs: Date.now() - startedAt,
        errorName: errorName(error),
        errorMessage: errorMessage(error).slice(0, 300),
      });
    }
  }

  throw new MemoryExtractionUnavailableError(timedOut);
}
