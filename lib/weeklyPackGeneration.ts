import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";

import type { ExperienceGraphRecord } from "./backendTypes";
import {
  fetchParallelResearchResult,
  startParallelResearch,
  type ParallelResearchResult,
} from "./parallelResearch";
import { findVenuePhoto } from "./venuePhoto";
import {
  auditWeeklyPackDesign,
  auditWeeklyPackResearch,
  buildWeeklyPackDesignPrompt,
  buildWeeklyPackResearchPrompt,
  canonicalizeWeeklyPackAnchors,
  weeklyPackDesignModelSchema,
  weeklyPackDesignSchema,
  weeklyPackResearchFindingSchema,
  type WeeklyPackContext,
  type WeeklyPackDesign,
  type WeeklyPackResearchFinding,
  type WeeklyPackScale,
} from "./weeklyPackDesign";
import {
  weeklyExperienceCardSchema,
  type WeeklyExperienceCard,
} from "./weeklyPackSchema";
import { generateWeeklyPackImage } from "./weeklyPackImageGeneration";
import {
  WEEKLY_PACK_PERSON_TOKEN,
  containsAnonymousPersonLanguage,
  resolveWeeklyPersonToken,
  type WeeklyPackCompanion,
} from "./weeklyPackSocial";

const PACK_MODEL_ID =
  process.env.CHAPTER_PACK_MODEL || "openai/gpt-5.6-terra";
const PACK_COMPOSITION_MODEL_ID =
  process.env.CHAPTER_PACK_COMPOSITION_MODEL || PACK_MODEL_ID;
const PACK_PROCESSOR =
  process.env.CHAPTER_PACK_PROCESSOR ||
  process.env.CHAPTER_NOW_PROCESSOR ||
  "core";

const BASELINE_REQUIREMENTS = {
  availability:
    "Verify that the experience and every critical dependency are currently accessible within the intended validity window. A current official walk-in policy, timetable, or open booking flow is sufficient unless the action depends on scarce live capacity.",
  cost: "Verify the complete expected cost when it can prevent the action. If no cost ceiling is supplied, an official no-commitment flow that reveals the final price before purchase is sufficient when the exact amount is not published.",
  travel:
    "Verify a practical outward and return journey, including the final arrival point and cutoff times.",
} as const;

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  compatibility: "strict",
  appName: "Chapter",
  appUrl: "https://chapter-buildoff.vercel.app",
});

export class WeeklyPackGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeeklyPackGenerationError";
  }
}

export const weeklyPackResearchRunSchema = z.object({
  cardId: z.enum(["small", "mini", "proper"]),
  runId: z.string().trim().min(1).max(160),
  attempt: z.number().int().min(1).max(2).default(1),
});

export const weeklyPackResearchRunsSchema = z
  .array(weeklyPackResearchRunSchema)
  .length(3);

export type WeeklyPackResearchRun = z.infer<typeof weeklyPackResearchRunSchema>;

const MAX_RESEARCH_ATTEMPTS_PER_CARD = 2;

export type WeeklyPackResearchPoll =
  | { status: "pending" }
  | {
      status: "retry";
      failedCardIds: WeeklyPackScale[];
      feedback: string;
      feedbackByCard: Partial<Record<WeeklyPackScale, string>>;
    }
  | {
      status: "completed";
      results: WeeklyPackResearchResult[];
      audit: ReturnType<typeof auditWeeklyPackResearch>;
    };

export const weeklyPackResearchResultSchema = z.object({
  cardId: z.enum(["small", "mini", "proper"]),
  runId: z.string().trim().min(1).max(160),
  finding: weeklyPackResearchFindingSchema,
  citations: z.array(
    z.object({
      url: z.string().url(),
      title: z.string().trim().min(1).max(300).optional(),
    }),
  ),
});

export type WeeklyPackResearchResult = z.infer<
  typeof weeklyPackResearchResultSchema
>;

const weeklyPackCopyModelSchema = z.object({
  cards: z.array(
    z.object({
      id: z.enum(["small", "mini", "proper"]),
      title: z.string(),
      line: z.string(),
      promise: z.string(),
      opening: z.string(),
      steps: z.array(z.string()),
    }),
  ),
});

const weeklyPackCopySchema = z.object({
  cards: z
    .array(
      z.object({
        id: z.enum(["small", "mini", "proper"]),
        title: z.string().trim().min(3).max(120),
        line: z.string().trim().min(20).max(240),
        promise: z.string().trim().min(20).max(500),
        opening: z.string().trim().min(20).max(1_000),
        steps: z.array(z.string().trim().min(8).max(500)).min(1).max(8),
      }),
    )
    .length(3),
});

type PackGenerationSource = {
  graph: ExperienceGraphRecord;
  context: WeeklyPackContext;
};

type PackReasoningEffort = "none" | "low";

export function weeklyPackReasoningEffortFor(
  modelId: string,
  override?: PackReasoningEffort,
) {
  if (override) return override;
  if (modelId.startsWith("anthropic/")) return "low" as const;
  if (modelId.includes("gpt-5.6-luna")) return "none" as const;
  if (modelId.startsWith("openai/")) return "low" as const;
  return "none" as const;
}

export function weeklyPackModelSettingsFor(
  modelId: string,
  reasoning: PackReasoningEffort,
) {
  const gpt56 = modelId.includes("gpt-5.6-");
  return {
    reasoning: { effort: reasoning },
    provider: {
      ...(gpt56 ? { order: ["azure"] } : {}),
      allow_fallbacks: true,
      data_collection: "deny" as const,
      // The AI SDK emits max_tokens while Azure advertises
      // max_completion_tokens. OpenRouter translates it, but its strict
      // parameter pre-filter would incorrectly remove the only ZDR endpoint.
      require_parameters: !gpt56,
      zdr: true,
    },
  };
}

function modelTuning(modelId: string, temperature: number) {
  return modelId.startsWith("anthropic/") || modelId.startsWith("openai/")
    ? {}
    : { temperature };
}

async function generateObject<T>(args: {
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
  requestId: string;
  reasoning?: PackReasoningEffort;
}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new WeeklyPackGenerationError(
      "OPENROUTER_API_KEY is not configured.",
    );
  }
  const startedAt = Date.now();
  try {
    const result = await generateText({
      // The OpenRouter adapter reads reasoning from its per-model settings.
      // Passing the generic AI SDK `reasoning` call option is ignored here.
      model: openrouter(
        args.modelId,
        weeklyPackModelSettingsFor(
          args.modelId,
          weeklyPackReasoningEffortFor(args.modelId, args.reasoning),
        ),
      ),
      messages: [{ role: "user", content: args.prompt }],
      output: Output.object({
        name: args.schemaName,
        description:
          "A strict Chapter weekly experience-pack production artifact.",
        schema: args.schema,
      }),
      ...modelTuning(args.modelId, args.temperature),
      maxOutputTokens: args.maxOutputTokens,
      maxRetries: 0,
      timeout: { totalMs: 180_000 },
    });
    console.info(
      [
        "[weekly-pack:generate] call completed",
        `requestId=${args.requestId}`,
        `schema=${args.schemaName}`,
        `model=${args.modelId}`,
        `elapsedMs=${Date.now() - startedAt}`,
        `finishReason=${result.finishReason}`,
        `inputTokens=${result.usage.inputTokens ?? "unknown"}`,
        `outputTokens=${result.usage.outputTokens ?? "unknown"}`,
        `reasoningTokens=${result.usage.outputTokenDetails.reasoningTokens ?? "unknown"}`,
        `textTokens=${result.usage.outputTokenDetails.textTokens ?? "unknown"}`,
      ].join(" "),
    );
    return args.schema.parse(result.output);
  } catch (error) {
    console.warn(
      [
        "[weekly-pack:generate] call failed",
        `requestId=${args.requestId}`,
        `schema=${args.schemaName}`,
        `model=${args.modelId}`,
        `elapsedMs=${Date.now() - startedAt}`,
        `error=${error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError"}`,
      ].join(" "),
    );
    throw error;
  }
}

function normalizeDesign(
  output: z.infer<typeof weeklyPackDesignModelSchema>,
  source: PackGenerationSource,
) {
  const candidate = weeklyPackDesignSchema.parse({
    ...output,
    cards: output.cards.map((card) => {
      const present = new Set(
        card.requirements.map((requirement) => requirement.kind),
      );
      return {
        ...card,
        requirements: [
          ...card.requirements,
          ...Object.entries(BASELINE_REQUIREMENTS).flatMap(([kind, detail]) =>
            present.has(kind as keyof typeof BASELINE_REQUIREMENTS)
              ? []
              : [
                  {
                    kind: kind as keyof typeof BASELINE_REQUIREMENTS,
                    detail,
                  },
                ],
          ),
        ],
      };
    }),
  });
  return canonicalizeWeeklyPackAnchors(candidate, source.graph);
}

type WeeklyPackModelAttempt<T> =
  { value: T } | { failure: string; correction: string };

export async function runWeeklyPackModelAttempts<T>(args: {
  modelIds: readonly string[];
  attemptsPerModel?: number;
  attempt: (args: {
    modelId: string;
    attempt: number;
    correction: string;
  }) => Promise<WeeklyPackModelAttempt<T>>;
}) {
  const failures: string[] = [];
  let correction = "";
  const attemptsPerModel = Math.max(1, Math.floor(args.attemptsPerModel ?? 2));

  for (const modelId of args.modelIds) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
      const result = await args.attempt({ modelId, attempt, correction });
      if ("value" in result) {
        return { value: result.value, failures };
      }
      failures.push(`${modelId} attempt ${attempt}: ${result.failure}`);
      correction = result.correction;
    }
  }

  return { failures };
}

async function structurallyValidDesign(args: {
  prompt: string;
  source: PackGenerationSource;
  modelIds: readonly string[];
  schemaName: string;
  requestId: string;
  temperature: number;
  transformPack?: (pack: WeeklyPackDesign) => WeeklyPackDesign;
}) {
  const result = await runWeeklyPackModelAttempts({
    modelIds: args.modelIds,
    attemptsPerModel: 4,
    attempt: async ({ modelId, correction }) => {
      try {
        const output = await generateObject({
          prompt: [args.prompt, correction].filter(Boolean).join("\n\n"),
          schema: weeklyPackDesignModelSchema,
          schemaName: args.schemaName,
          modelId,
          temperature: args.temperature,
          maxOutputTokens: 16_000,
          requestId: args.requestId,
        });
        const normalizedPack = normalizeDesign(output, args.source);
        const pack = args.transformPack
          ? args.transformPack(normalizedPack)
          : normalizedPack;
        const audit = auditWeeklyPackDesign({
          pack,
          graph: args.source.graph,
          context: args.source.context,
        });
        if (audit.valid) return { value: pack };

        const failure = audit.errors
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("\n");
        return {
          failure,
          correction: [
            "The previous full pack failed deterministic gates.",
            "Return all three cards again. Repair every failure without weakening the pre-drawn Chapter shape, format, social, privacy, or evidence contracts.",
            `PREVIOUS INVALID PACK: ${JSON.stringify(pack)}`,
            "EXACT FAILURES:",
            failure,
          ].join("\n"),
        };
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        return {
          failure,
          correction: [
            correction,
            "The previous attempt did not return a valid structured pack.",
            "Return one complete pack with exactly three cards and every required field. Do not include commentary outside the structured result.",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
    },
  });
  if (result.value) {
    return result.value;
  }
  throw new WeeklyPackGenerationError(
    `No model produced a structurally valid pack. ${result.failures.join(" | ")}`,
  );
}

export async function designWeeklyPack(args: {
  source: PackGenerationSource;
  requestId: string;
}) {
  const pack = await structurallyValidDesign({
    prompt: buildWeeklyPackDesignPrompt({
      graph: args.source.graph,
      context: args.source.context,
    }),
    source: args.source,
    modelIds: [PACK_MODEL_ID],
    schemaName: "weekly_pack_design",
    requestId: args.requestId,
    temperature: 0.72,
  });
  return { pack };
}

export async function redesignWeeklyPackAfterResearchFailure(args: {
  source: PackGenerationSource;
  requestId: string;
  previousPack: WeeklyPackDesign;
  failedCardIds: readonly WeeklyPackScale[];
  abandonedDirections: readonly {
    cardId: WeeklyPackScale;
    experiencePromise: string;
    mechanismKind: string;
    mechanismDescription: string;
    failure: string;
  }[];
  feedback: string;
}) {
  const failedCardIds = new Set(args.failedCardIds);
  if (failedCardIds.size === 0) {
    throw new WeeklyPackGenerationError(
      "Research recovery did not identify a failed card.",
    );
  }
  const preservedCards = args.previousPack.cards.filter(
    (card) => !failedCardIds.has(card.id),
  );
  const pack = await structurallyValidDesign({
    prompt: [
      buildWeeklyPackDesignPrompt({
        graph: args.source.graph,
        context: args.source.context,
      }),
      "",
      "LIVE RESEARCH RECOVERY",
      "Live research proved that the abandoned directions below cannot currently satisfy Chapter's deterministic truth gates.",
      `Replace only these failed cards: ${[...failedCardIds].join(", ")}.`,
      "Choose a genuinely different participant action and established public format while preserving each failed card's pre-drawn shape contract, basis, dimensions, company, and scale.",
      "Do not revisit an abandoned activity family by changing only its venue, provider, recipe, route, or wording.",
      "Every card not named as failed is already proved. It will be preserved byte-for-byte and must remain compatible with the replacement directions.",
      `PROVED CARDS TO PRESERVE: ${JSON.stringify(preservedCards)}`,
      `ALL ABANDONED DIRECTIONS: ${JSON.stringify(args.abandonedDirections)}`,
      `LATEST RESEARCH FAILURES: ${args.feedback}`,
    ].join("\n"),
    source: args.source,
    modelIds: [PACK_MODEL_ID],
    schemaName: "weekly_pack_research_recovery",
    requestId: args.requestId,
    temperature: 0.68,
    transformPack: (candidate) => ({
      ...candidate,
      cards: candidate.cards.map((card) => {
        const preserved = args.previousPack.cards.find(
          (previous) => previous.id === card.id && !failedCardIds.has(card.id),
        );
        return preserved ?? card;
      }),
    }),
  });
  return { pack };
}

async function startWeeklyPackResearchRuns(args: {
  pack: WeeklyPackDesign;
  context: WeeklyPackContext;
  weekKey: string;
  cardIds: readonly WeeklyPackScale[];
}) {
  const requestedCardIds = new Set(args.cardIds);
  const cards = args.pack.cards.filter((card) =>
    requestedCardIds.has(card.id),
  );
  if (cards.length === 0 || cards.length !== requestedCardIds.size) {
    throw new WeeklyPackGenerationError(
      "Weekly research could not match every requested card.",
    );
  }
  return Promise.all(
    cards.map(async (card) => {
      const { runId } = await startParallelResearch({
        processor: PACK_PROCESSOR,
        input: buildWeeklyPackResearchPrompt({
          card,
          context: args.context,
          currentDate: new Date().toISOString().slice(0, 10),
        }),
        outputSchema: z.toJSONSchema(weeklyPackResearchFindingSchema) as Record<
          string,
          unknown
        >,
        metadata: {
          app: "chapter",
          surface: "weekly-pack",
          week: args.weekKey,
          card: card.id,
        },
      });
      return weeklyPackResearchRunSchema.parse({
        cardId: card.id,
        runId,
        attempt: 1,
      });
    }),
  );
}

export async function startWeeklyPackResearch(args: {
  pack: WeeklyPackDesign;
  context: WeeklyPackContext;
  weekKey: string;
}) {
  const runs = await startWeeklyPackResearchRuns({
    ...args,
    cardIds: args.pack.cards.map(({ id }) => id),
  });
  return weeklyPackResearchRunsSchema.parse(runs);
}

export function startWeeklyPackResearchForCards(args: {
  pack: WeeklyPackDesign;
  context: WeeklyPackContext;
  weekKey: string;
  cardIds: readonly WeeklyPackScale[];
}) {
  return startWeeklyPackResearchRuns(args);
}

export async function retryWeeklyPackResearch(args: {
  pack: WeeklyPackDesign;
  runs: WeeklyPackResearchRun[];
  homeCity: string;
  weekKey: string;
  failedCardIds: readonly WeeklyPackScale[];
  feedback: string;
  feedbackByCard?: Partial<Record<WeeklyPackScale, string>>;
}, startResearch = startParallelResearch) {
  const failedCardIds = new Set(args.failedCardIds);
  if (failedCardIds.size === 0) {
    throw new WeeklyPackGenerationError(
      "Research retry did not identify a failed card.",
    );
  }

  const retryRuns = args.runs.filter((run) => failedCardIds.has(run.cardId));
  if (retryRuns.length !== failedCardIds.size) {
    throw new WeeklyPackGenerationError(
      "Research retry did not match every failed card to a stored run.",
    );
  }
  const exhausted = retryRuns.find(
    (run) => run.attempt >= MAX_RESEARCH_ATTEMPTS_PER_CARD,
  );
  if (exhausted) {
    throw new WeeklyPackGenerationError(
      `Research for ${exhausted.cardId} failed after ${exhausted.attempt} attempts.`,
    );
  }
  const missingDesign = retryRuns.find(
    (run) => !args.pack.cards.some(({ id }) => id === run.cardId),
  );
  if (missingDesign) {
    throw new WeeklyPackGenerationError(
      `Research retry could not find the ${missingDesign.cardId} design.`,
    );
  }

  const context: WeeklyPackContext = {
    homeCity: args.homeCity,
    privacyMode: "personal",
    availableCompanies: [
      ...new Set(args.pack.cards.map((card) => card.format.company)),
    ],
  };
  const nextRuns = await Promise.all(
    args.runs.map(async (run) => {
      if (!failedCardIds.has(run.cardId)) return run;

      const card = args.pack.cards.find(({ id }) => id === run.cardId);
      // Preflight above proves the design exists before any paid run starts.
      if (!card) throw new WeeklyPackGenerationError("Missing retry design.");
      const attempt = run.attempt + 1;
      const { runId } = await startResearch({
        processor: PACK_PROCESSOR,
        input: [
          buildWeeklyPackResearchPrompt({
            card,
            context,
            currentDate: new Date().toISOString().slice(0, 10),
          }),
          "",
          "RESEARCH RETRY",
          "The previous finding failed Chapter's deterministic truth gates. Search different candidates when necessary; do not defend or lightly rewrite the failed finding.",
          `EXACT FAILURE: ${(args.feedbackByCard?.[run.cardId] ?? args.feedback).slice(0, 6_000)}`,
          "Return researchCaveats only when a critical dependency remains unproved. An unresolved critical dependency must remain explicit and will fail this card again.",
        ].join("\n"),
        outputSchema: z.toJSONSchema(
          weeklyPackResearchFindingSchema,
        ) as Record<string, unknown>,
        metadata: {
          app: "chapter",
          surface: "weekly-pack-retry",
          week: args.weekKey,
          card: card.id,
          attempt: `${attempt}`,
        },
      });
      return { cardId: run.cardId, runId, attempt };
    }),
  );
  return weeklyPackResearchRunsSchema.parse(nextRuns);
}

export async function pollWeeklyPackResearch(args: {
  pack: WeeklyPackDesign;
  runs: WeeklyPackResearchRun[];
  homeCity?: string;
  requestId?: string;
}, fetchResearch = fetchParallelResearchResult): Promise<WeeklyPackResearchPoll> {
  const results: Array<{
    run: WeeklyPackResearchRun;
    result: ParallelResearchResult;
  }> = [];
  for (const run of args.runs) {
    results.push({
      run,
      // Parallel can answer otherwise-complete result reads with 408 when a
      // pack polls all three runs in a burst. One transient 408 keeps the
      // entire pack pending, so read a pack's results serially while the
      // worker still advances different users concurrently.
      result: await fetchResearch(run.runId, 2),
    });
  }
  const providerFailures = results
    .filter(({ result }) => result.status === "failed")
    .map(({ run }) => run.cardId);
  if (providerFailures.length > 0) {
    const feedbackByCard = Object.fromEntries(
      providerFailures.map((cardId) => [
        cardId,
        `Parallel failed research for ${cardId}.`,
      ]),
    );
    return {
      status: "retry",
      failedCardIds: providerFailures,
      feedback: `Parallel failed research for ${providerFailures.join(", ")}.`,
      feedbackByCard,
    };
  }
  if (results.some(({ result }) => result.status === "pending")) {
    return { status: "pending" as const };
  }

  const completed: WeeklyPackResearchResult[] = [];
  const invalidCards: WeeklyPackScale[] = [];
  const invalidMessages: string[] = [];
  for (const { run, result } of results) {
    try {
      if (result.status !== "completed") {
        throw new Error("Research is not complete.");
      }
      const raw =
        typeof result.content === "string"
          ? JSON.parse(result.content)
          : result.content;
      const finding = weeklyPackResearchFindingSchema.parse(raw);
      if (finding.cardId !== run.cardId) {
        throw new Error(`returned card id ${finding.cardId}`);
      }
      completed.push(
        weeklyPackResearchResultSchema.parse({
          cardId: run.cardId,
          runId: run.runId,
          finding,
          citations: result.citations,
        }),
      );
    } catch (error) {
      invalidCards.push(run.cardId);
      invalidMessages.push(
        `${run.cardId}: ${error instanceof Error ? error.message : "invalid structured result"}`,
      );
    }
  }
  if (invalidCards.length > 0) {
    return {
      status: "retry",
      failedCardIds: invalidCards,
      feedback: invalidMessages.join("\n"),
      feedbackByCard: Object.fromEntries(
        invalidCards.map((cardId, index) => [cardId, invalidMessages[index]]),
      ),
    };
  }
  const audit = auditWeeklyPackResearch({
    pack: args.pack,
    findings: completed.map((result) => result.finding),
    homeCity: args.homeCity,
  });
  if (!audit.valid) {
    const failedCardIds = new Set<WeeklyPackScale>();
    for (const issue of audit.errors) {
      if (
        issue.cardId === "small" ||
        issue.cardId === "mini" ||
        issue.cardId === "proper"
      ) {
        failedCardIds.add(issue.cardId);
      }
    }
    for (const cardId of audit.collidingCardIds) {
      if (
        cardId === "small" ||
        cardId === "mini" ||
        cardId === "proper"
      ) {
        failedCardIds.add(cardId);
      }
    }
    const orderedFailedCardIds =
      failedCardIds.size > 0
        ? [...failedCardIds]
        : args.pack.cards.map(({ id }) => id);
    const feedbackByCard = Object.fromEntries(
      orderedFailedCardIds.map((cardId) => {
        const cardIssues = audit.errors.filter(
          (issue) =>
            issue.cardId === cardId ||
            (!issue.cardId && audit.collidingCardIds.includes(cardId)),
        );
        const messages = cardIssues.length > 0 ? cardIssues : audit.errors;
        return [
          cardId,
          messages
            .map(
              (issue) =>
                `${issue.cardId ? `${issue.cardId} ` : ""}${issue.code}: ${issue.message}`,
            )
            .join("\n"),
        ];
      }),
    );
    return {
      status: "retry",
      failedCardIds: orderedFailedCardIds,
      feedback: audit.errors
        .map(
          (issue) =>
            `${issue.cardId ? `${issue.cardId} ` : ""}${issue.code}: ${issue.message}`,
        )
        .join("\n"),
      feedbackByCard,
    };
  }
  console.info(
    [
      "[weekly-pack:research] audited",
      `requestId=${args.requestId ?? "unknown"}`,
      `places=${JSON.stringify(
        completed.map((result) => ({
          cardId: result.cardId,
          name: result.finding.primaryPlace.name,
          area: result.finding.primaryPlace.area,
          destinationCity: result.finding.travelFit?.destinationCity,
          roundTripMinutes: result.finding.travelFit?.roundTripMinutes,
        })),
      )}`,
    ].join(" "),
  );
  return { status: "completed" as const, results: completed, audit };
}

export function buildWeeklyPackCompositionPrompt(args: {
  pack: WeeklyPackDesign;
  research: WeeklyPackResearchResult[];
  companion?: WeeklyPackCompanion;
}) {
  return [
    "Write the visible copy for three already-designed, already-researched Chapter cards.",
    "Return one small, one mini, and one proper card.",
    "",
    "COPY CONTRACT",
    "- Preserve the researched action, place, route, company, scale, and logistics. Do not redesign anything.",
    "- Use only claims present in the design and research. Do not invent biography, preference, emotion, safety, availability, cost, or travel facts.",
    "- Title: a plain 3-7 word name for the core action. Do not put the provider's full name, class name, technique list, schedule, or explanatory clause in the title.",
    "- Line: one natural sentence, 12-32 words, that presents the experience as an invitation and includes that card's verified primaryPlace.name verbatim.",
    "- On graph or social cards, use 1-3 accepted anchor labels verbatim where they fit naturally so the interface can mark those real nodes.",
    "- On world cards, write the invitation plainly from the researched action and place. Do not invent a personal reason or imply that the memory graph caused it.",
    "- Promise: one concrete sentence stating what the person will actually do.",
    "- Opening: 1-2 unhurried sentences that make the action legible without explaining personalization.",
    "- Steps: 2-5 concise actions forming the researched rhythm or route. Do not pad a small activity into an itinerary.",
    "- Do not add arbitrary quotas, counting exercises, audits, documentation tasks, ratings, cataloguing, pretending, or role-play. Avoid the words exactly, audit, document, log, rate, catalogue, pretend, role-play, and roleplay, plus phrases such as at least two, at least three, or at least four, anywhere in visible copy.",
    "- No marketing language, destiny, exclamation marks, compatibility claims, or mention of Chapter's machinery.",
    args.companion
      ? [
          `- One social card has a real server-confirmed person. Refer to that person with the exact token ${WEEKLY_PACK_PERSON_TOKEN}; the server replaces it with their actual name after generation.`,
          `- The social card's line must contain ${WEEKLY_PACK_PERSON_TOKEN}.`,
          "- Never write someone new, a new person, a stranger, someone you know, a friend, bring someone, or another anonymous substitute.",
        ].join("\n")
      : "- No matched person exists. Do not write a social card or suggest bringing somebody.",
    "",
    `ACCEPTED DESIGN: ${JSON.stringify(args.pack)}`,
    `VERIFIED RESEARCH: ${JSON.stringify(args.research)}`,
  ].join("\n");
}

export function validateWeeklyPackSocialCopy(args: {
  pack: WeeklyPackDesign;
  copy: z.infer<typeof weeklyPackCopySchema>;
  companion?: WeeklyPackCompanion;
}) {
  const socialDesigns = args.pack.cards.filter(
    (card) => card.format.company !== "self",
  );
  if (!args.companion) {
    if (socialDesigns.length > 0) {
      throw new WeeklyPackGenerationError(
        "A social card was composed without a real person.",
      );
    }
    return;
  }
  if (socialDesigns.length !== 1) {
    throw new WeeklyPackGenerationError(
      "A matched person must belong to exactly one card.",
    );
  }

  const design = socialDesigns[0];
  const expectedCompany =
    args.companion.familiarity === "new" ? "new-person" : "known-person";
  if (design.format.company !== expectedCompany) {
    throw new WeeklyPackGenerationError(
      "The social card does not match the real person's familiarity.",
    );
  }
  const copy = args.copy.cards.find((card) => card.id === design.id);
  if (!copy) {
    throw new WeeklyPackGenerationError("The social card copy is missing.");
  }
  if (!copy.line.includes(WEEKLY_PACK_PERSON_TOKEN)) {
    throw new WeeklyPackGenerationError(
      "The social card line did not identify its real person.",
    );
  }
  const visibleCopy = [
    copy.title,
    copy.line,
    copy.promise,
    copy.opening,
    ...copy.steps,
  ].join("\n");
  if (containsAnonymousPersonLanguage(visibleCopy)) {
    throw new WeeklyPackGenerationError(
      "The social card used anonymous person language.",
    );
  }
}

export function validateWeeklyPackGroundedCopy(args: {
  research: readonly WeeklyPackResearchResult[];
  copy: z.infer<typeof weeklyPackCopySchema>;
}) {
  for (const card of args.copy.cards) {
    const finding = args.research.find(
      (candidate) => candidate.cardId === card.id,
    )?.finding;
    if (!finding) {
      throw new WeeklyPackGenerationError(
        `Copy for ${card.id} has no completed research finding.`,
      );
    }
    if (!card.line.includes(finding.primaryPlace.name)) {
      throw new WeeklyPackGenerationError(
        `${card.id} copy did not name its verified real-world place verbatim.`,
      );
    }
    const titleWords = card.title.split(/\s+/u).filter(Boolean);
    if (
      titleWords.length > 7 ||
      /[,;:.!?—]/u.test(card.title) ||
      card.title.includes(finding.primaryPlace.name)
    ) {
      throw new WeeklyPackGenerationError(
        `${card.id} title must be a short action name, not a sentence or logistics list.`,
      );
    }
    const visibleCopy = [
      card.title,
      card.line,
      card.promise,
      card.opening,
      ...card.steps,
    ].join(" ");
    if (
      /\b(exactly|at least (?:two|three|four)|audit|document|log|rate|catalogue|pretend|role-play|roleplay)\b/i.test(
        visibleCopy,
      )
    ) {
      throw new WeeklyPackGenerationError(
        `${card.id} copy introduced an artificial task or role-playing instruction.`,
      );
    }
  }
}

const PRACTICAL_LABELS: Record<
  keyof WeeklyPackResearchFinding["logistics"],
  string
> = {
  availability: "Availability",
  booking: "Booking",
  cost: "Cost",
  travel: "Travel",
  equipment: "Bring",
  accessibility: "Access",
  weather: "Weather",
  safety: "Safety",
};

export function materializeWeeklyExperienceCards(args: {
  pack: WeeklyPackDesign;
  research: WeeklyPackResearchResult[];
  copy: z.infer<typeof weeklyPackCopySchema>;
  companion?: WeeklyPackCompanion;
  images?: Partial<
    Record<
      WeeklyPackScale,
      NonNullable<WeeklyExperienceCard["image"]> | undefined
    >
  >;
}): WeeklyExperienceCard[] {
  validateWeeklyPackSocialCopy(args);
  const cards = args.pack.cards.map((design) => {
    const result = args.research.find(
      (candidate) => candidate.cardId === design.id,
    );
    const copy = args.copy.cards.find(
      (candidate) => candidate.id === design.id,
    );
    if (!result || !copy) {
      throw new WeeklyPackGenerationError(
        `Finished card ${design.id} is incomplete.`,
      );
    }
    const sourceUrls = Array.from(
      new Set([
        ...result.finding.criticalFacts.flatMap((fact) => fact.sourceUrls),
        ...result.citations.map((citation) => citation.url),
      ]),
    );
    const social = design.format.company !== "self";
    const visibleCopy =
      social && args.companion
        ? {
            title: resolveWeeklyPersonToken(copy.title, args.companion),
            line: resolveWeeklyPersonToken(copy.line, args.companion),
            promise: resolveWeeklyPersonToken(copy.promise, args.companion),
            opening: resolveWeeklyPersonToken(copy.opening, args.companion),
            steps: copy.steps.map((step) =>
              resolveWeeklyPersonToken(step, args.companion!),
            ),
          }
        : copy;
    return weeklyExperienceCardSchema.parse({
      id: design.id,
      scale: design.format.scale,
      company: design.format.company,
      title: visibleCopy.title,
      line: visibleCopy.line,
      anchors: design.anchors,
      promise: visibleCopy.promise,
      opening: visibleCopy.opening,
      durationMinutes: design.format.durationMinutes,
      place: result.finding.primaryPlace,
      ...(social ? { companion: args.companion } : {}),
      steps: visibleCopy.steps,
      practical: Object.entries(result.finding.logistics).map(
        ([key, value]) => ({
          label:
            PRACTICAL_LABELS[
              key as keyof WeeklyPackResearchFinding["logistics"]
            ],
          value,
        }),
      ),
      sourceUrls,
      image: args.images?.[design.id] ?? null,
    });
  });
  return z.array(weeklyExperienceCardSchema).length(3).parse(cards);
}

export async function composeWeeklyExperienceCards(args: {
  pack: WeeklyPackDesign;
  research: WeeklyPackResearchResult[];
  requestId: string;
  companion?: WeeklyPackCompanion;
}) {
  const copyAttempts = await runWeeklyPackModelAttempts({
    modelIds: [PACK_COMPOSITION_MODEL_ID],
    attemptsPerModel: 4,
    attempt: async ({ modelId, correction }) => {
      try {
        const output = await generateObject({
          prompt: [buildWeeklyPackCompositionPrompt(args), correction]
            .filter(Boolean)
            .join("\n\n"),
          schema: weeklyPackCopyModelSchema,
          schemaName: "weekly_pack_card_copy",
          modelId,
          temperature: 0.3,
          maxOutputTokens: 5_000,
          requestId: args.requestId,
        });
        const candidate = weeklyPackCopySchema.parse(output);
        validateWeeklyPackSocialCopy({
          pack: args.pack,
          copy: candidate,
          companion: args.companion,
        });
        validateWeeklyPackGroundedCopy({
          research: args.research,
          copy: candidate,
        });
        return { value: candidate };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          failure: message,
          correction: [
            "The previous complete copy set failed a deterministic truth gate.",
            "Return all three cards again and repair this exact failure without redesigning the accepted experiences:",
            message,
          ].join("\n"),
        };
      }
    },
  });
  if (!copyAttempts.value) {
    throw new WeeklyPackGenerationError(
      `No model produced truthful grounded copy. ${copyAttempts.failures.join(" | ")}`,
    );
  }
  const copy = copyAttempts.value;
  const images = Object.fromEntries(
    await Promise.all(
      args.pack.cards.map(async (design) => {
        const result = args.research.find(
          (candidate) => candidate.cardId === design.id,
        );
        const cardCopy = copy.cards.find(
          (candidate) => candidate.id === design.id,
        );
        if (!result || !cardCopy) {
          throw new WeeklyPackGenerationError(
            `Image input for ${design.id} is incomplete.`,
          );
        }

        try {
          return [
            design.id,
            await generateWeeklyPackImage({
              design,
              finding: result.finding,
              copy: cardCopy,
              requestId: args.requestId,
            }),
          ] as const;
        } catch (error) {
          console.warn("[weekly-pack:image] generation unavailable", {
            requestId: args.requestId,
            cardId: design.id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          const fallbackUrl = await findVenuePhoto(result.citations);
          return [
            design.id,
            fallbackUrl
              ? {
                  url: fallbackUrl,
                  alt: result.finding.primaryPlace
                    ? `A view of ${result.finding.primaryPlace.name}`
                    : `A photograph connected to ${cardCopy.title}`,
                  kind: "photograph" as const,
                }
              : undefined,
          ] as const;
        }
      }),
    ),
  ) as Partial<
    Record<
      WeeklyPackScale,
      NonNullable<WeeklyExperienceCard["image"]> | undefined
    >
  >;
  return materializeWeeklyExperienceCards({
    pack: args.pack,
    research: args.research,
    copy,
    companion: args.companion,
    images,
  });
}
