import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";

import {
  auditWeeklyPackDesign,
  buildWeeklyPackDesignPrompt,
  buildWeeklyPackRevisionPrompt,
  buildWeeklyPackReviewPrompt,
  canonicalizeWeeklyPackAnchors,
  enforceWeeklyPackReviewThresholds,
  weeklyPackDesignModelSchema,
  weeklyPackDesignSchema,
  weeklyPackReviewModelSchema,
  weeklyPackReviewSchema,
  type WeeklyPackDesign,
  type WeeklyPackReview,
} from "../lib/weeklyPackDesign";
import {
  WEEKLY_PACK_FIXTURES,
  weeklyPackFixtureById,
  type WeeklyPackFixture,
} from "./weekly-pack-fixtures";
import { researchWeeklyPack } from "./weekly-pack-research";

type LabMode = "prompt" | "design" | "audit" | "research";

type LabOptions = {
  mode: LabMode;
  fixtureId: string;
  designFile?: string;
  outputFile?: string;
  allowPaidResearch: boolean;
  listFixtures: boolean;
  help: boolean;
};

type GeneratedPack = {
  pack: WeeklyPackDesign;
  model: string;
  attempts: number;
};

type RevisionRecord = {
  round: number;
  model: string;
  attempts: number;
  review: WeeklyPackReview;
  reviewModel: string;
};

const BASELINE_REQUIREMENTS = {
  availability:
    "Verify that the experience and every critical dependency are currently available within the intended validity window.",
  cost: "Verify the complete expected cost, including any booking, materials, admission, and transport.",
  travel:
    "Verify a practical outward and return journey, including the final arrival point and any cutoff times.",
} as const;

function helpText() {
  return `
Chapter weekly pack lab

Usage:
  npm run lab:weekly-pack -- --mode prompt --fixture sparse
  npm run lab:weekly-pack -- --mode design --fixture food-heavy --output ./tmp/food-pack.json
  npm run lab:weekly-pack -- --mode audit --fixture food-heavy --design-file ./tmp/food-pack.json
  npm run lab:weekly-pack -- --mode research --fixture food-heavy --design-file ./tmp/food-pack.json --allow-paid-research

Modes:
  prompt    Print the full zero-cost design prompt for a synthetic fixture.
  design    Run OpenRouter to design and independently review a pack.
  audit     Run deterministic gates against an existing design file.
  research  Start exactly three independent Parallel research runs.

Safety:
  prompt and audit never call a model or research provider.
  design requires OPENROUTER_API_KEY.
  research requires PARALLEL_API_KEY and --allow-paid-research.

Options:
  --fixture <id>       Synthetic fixture (default: sparse).
  --design-file <path> Raw pack JSON or a prior lab output containing "pack".
  --output <path>      Also write the JSON result to this path.
  --list-fixtures      List the available synthetic fixtures.
  --help               Show this help.
`.trim();
}

function parseArgs(argv: string[]): LabOptions {
  const options: LabOptions = {
    mode: "prompt",
    fixtureId: "sparse",
    allowPaidResearch: false,
    listFixtures: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      const mode = argv[index + 1] as LabMode | undefined;
      if (!mode || !["prompt", "design", "audit", "research"].includes(mode)) {
        throw new Error("--mode must be prompt, design, audit, or research.");
      }
      options.mode = mode;
      index += 1;
    } else if (argument === "--fixture") {
      options.fixtureId = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--design-file") {
      options.designFile = argv[index + 1];
      index += 1;
    } else if (argument === "--output") {
      options.outputFile = argv[index + 1];
      index += 1;
    } else if (argument === "--allow-paid-research") {
      options.allowPaidResearch = true;
    } else if (argument === "--list-fixtures") {
      options.listFixtures = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function openRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  return createOpenRouter({
    apiKey,
    compatibility: "strict",
    appName: "Chapter weekly pack lab",
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
}

function modelTuning(modelId: string, temperature: number) {
  if (modelId.startsWith("anthropic/")) {
    return { reasoning: "low" as const };
  }
  if (modelId.startsWith("openai/")) {
    return { reasoning: "minimal" as const };
  }
  if (
    modelId.startsWith("google/gemini-3.") ||
    modelId.startsWith("google/gemini-3-")
  ) {
    return { reasoning: "minimal" as const, temperature };
  }
  return { reasoning: "none" as const, temperature };
}

async function generateObject<T>(args: {
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
}) {
  const provider = openRouter();
  const result = await generateText({
    model: provider(args.modelId),
    messages: [{ role: "user", content: args.prompt }],
    output: Output.object({
      name: args.schemaName,
      description:
        "A strict Chapter experience-design artifact for offline evaluation.",
      schema: args.schema,
    }),
    ...modelTuning(args.modelId, args.temperature),
    maxOutputTokens: args.maxOutputTokens,
    maxRetries: 0,
    timeout: { totalMs: 240_000 },
  });
  return args.schema.parse(result.output);
}

async function generatePack(fixture: WeeklyPackFixture): Promise<GeneratedPack> {
  const primaryModel =
    process.env.CHAPTER_PACK_MODEL || "openai/gpt-5.6-terra";
  const fallbackModel =
    process.env.CHAPTER_PACK_FALLBACK_MODEL || "moonshotai/kimi-k2.6";
  const modelIds = [
    primaryModel,
    primaryModel,
    ...(fallbackModel === primaryModel ? [] : [fallbackModel]),
  ];

  const basePrompt = buildWeeklyPackDesignPrompt({
    graph: fixture.graph,
    context: fixture.context,
  });
  let correction = "";
  const failures: string[] = [];

  for (const [attempt, modelId] of modelIds.entries()) {
    try {
      const output = await generateObject({
        prompt: [basePrompt, correction].filter(Boolean).join("\n\n"),
        schema: weeklyPackDesignModelSchema,
        schemaName: "weekly_pack_design",
        modelId,
        temperature: 0.72,
        maxOutputTokens: 16_000,
      });
      const pack = normalizeGeneratedPack(output, fixture);
      const audit = auditWeeklyPackDesign({
        pack,
        graph: fixture.graph,
        context: fixture.context,
      });
      if (audit.valid) {
        return { pack, model: modelId, attempts: attempt + 1 };
      }
      const failure = audit.errors
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n");
      failures.push(`${modelId}\n${failure}`);
      correction = [
        "The previous candidate failed deterministic gates.",
        "Return a complete corrected pack, not a patch.",
        failure,
      ].join("\n");
    } catch (error) {
      failures.push(
        `${modelId}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `No model produced a structurally valid pack.\n${failures.join("\n\n")}`,
  );
}

function normalizeGeneratedPack(
  output: z.infer<typeof weeklyPackDesignModelSchema>,
  fixture: WeeklyPackFixture,
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
  return canonicalizeWeeklyPackAnchors(candidate, fixture.graph);
}

async function reviewPack(args: {
  fixture: WeeklyPackFixture;
  pack: WeeklyPackDesign;
}): Promise<{ review: WeeklyPackReview; model: string }> {
  const modelId =
    process.env.CHAPTER_PACK_REVIEW_MODEL ||
    process.env.CHAPTER_PACK_MODEL ||
    "openai/gpt-5.6-terra";
  const output = await generateObject({
    prompt: buildWeeklyPackReviewPrompt({
      pack: args.pack,
      graph: args.fixture.graph,
      context: args.fixture.context,
    }),
    schema: weeklyPackReviewModelSchema,
    schemaName: "weekly_pack_review",
    modelId,
    temperature: 0.15,
    maxOutputTokens: 8_000,
  });
  const review = weeklyPackReviewSchema.parse(output);
  return {
    review: enforceWeeklyPackReviewThresholds(review),
    model: modelId,
  };
}

async function revisePack(args: {
  fixture: WeeklyPackFixture;
  pack: WeeklyPackDesign;
  review: WeeklyPackReview;
}): Promise<GeneratedPack> {
  const primaryModel =
    process.env.CHAPTER_PACK_REVISION_MODEL ||
    process.env.CHAPTER_PACK_MODEL ||
    "openai/gpt-5.6-terra";
  const fallbackModel =
    process.env.CHAPTER_PACK_FALLBACK_MODEL || "moonshotai/kimi-k2.6";
  const modelIds = [
    primaryModel,
    ...(fallbackModel === primaryModel ? [] : [fallbackModel]),
  ];
  const basePrompt = buildWeeklyPackRevisionPrompt({
    pack: args.pack,
    review: args.review,
    graph: args.fixture.graph,
    context: args.fixture.context,
  });
  const failures: string[] = [];
  let correction = "";

  for (const [attempt, modelId] of modelIds.entries()) {
    try {
      const output = await generateObject({
        prompt: [basePrompt, correction].filter(Boolean).join("\n\n"),
        schema: weeklyPackDesignModelSchema,
        schemaName: "weekly_pack_revision",
        modelId,
        temperature: 0.48,
        maxOutputTokens: 16_000,
      });
      const pack = normalizeGeneratedPack(output, args.fixture);
      const audit = auditWeeklyPackDesign({
        pack,
        graph: args.fixture.graph,
        context: args.fixture.context,
      });
      if (audit.valid) {
        return { pack, model: modelId, attempts: attempt + 1 };
      }
      const failure = audit.errors
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("\n");
      failures.push(`${modelId}\n${failure}`);
      correction = [
        "That revision still failed deterministic gates.",
        "Return the complete pack again and repair all of these failures:",
        failure,
      ].join("\n");
    } catch (error) {
      failures.push(
        `${modelId}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `No model produced a structurally valid revision.\n${failures.join("\n\n")}`,
  );
}

async function readDesignArtifact(path: string) {
  const payload = JSON.parse(await readFile(resolve(path), "utf8"));
  const candidate =
    payload && typeof payload === "object" && "pack" in payload
      ? payload.pack
      : payload;
  const reviewCandidate =
    payload && typeof payload === "object" && "review" in payload
      ? weeklyPackReviewSchema.safeParse(payload.review)
      : null;
  return {
    pack: weeklyPackDesignSchema.parse(candidate),
    review:
      reviewCandidate && reviewCandidate.success
        ? enforceWeeklyPackReviewThresholds(reviewCandidate.data)
        : null,
  };
}

async function writeResult(path: string, result: unknown) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return absolutePath;
}

function listFixtures() {
  return WEEKLY_PACK_FIXTURES.map(({ id, description, context }) => ({
    id,
    description,
    privacyMode: context.privacyMode,
    availableCompanies: context.availableCompanies,
  }));
}

async function run(options: LabOptions) {
  if (options.help) return { help: helpText() };
  if (options.listFixtures) return { fixtures: listFixtures() };

  const fixture = weeklyPackFixtureById(options.fixtureId);
  if (!fixture) {
    throw new Error(
      `Unknown fixture "${options.fixtureId}". Use --list-fixtures.`,
    );
  }

  if (options.mode === "prompt") {
    return {
      mode: options.mode,
      fixture: {
        id: fixture.id,
        description: fixture.description,
        context: fixture.context,
      },
      prompt: buildWeeklyPackDesignPrompt({
        graph: fixture.graph,
        context: fixture.context,
      }),
    };
  }

  if (options.mode === "design") {
    let generated = await generatePack(fixture);
    const initialGeneration = {
      model: generated.model,
      attempts: generated.attempts,
    };
    const revisions: RevisionRecord[] = [];
    const maximumRevisions = Math.max(
      0,
      Math.min(
        3,
        Number.parseInt(process.env.CHAPTER_PACK_MAX_REVISIONS || "2", 10) ||
          0,
      ),
    );
    let reviewed = await reviewPack({ fixture, pack: generated.pack });

    for (
      let round = 1;
      reviewed.review.verdict !== "accept" && round <= maximumRevisions;
      round += 1
    ) {
      const rejectedReview = reviewed;
      generated = await revisePack({
        fixture,
        pack: generated.pack,
        review: rejectedReview.review,
      });
      revisions.push({
        round,
        model: generated.model,
        attempts: generated.attempts,
        review: rejectedReview.review,
        reviewModel: rejectedReview.model,
      });
      reviewed = await reviewPack({ fixture, pack: generated.pack });
    }
    const audit = auditWeeklyPackDesign({
      pack: generated.pack,
      graph: fixture.graph,
      context: fixture.context,
    });
    return {
      mode: options.mode,
      requestId: randomUUID(),
      fixture: fixture.id,
      pack: generated.pack,
      audit,
      generation: {
        initial: initialGeneration,
        revisions,
        finalModel: generated.model,
        totalDesignAttempts:
          initialGeneration.attempts +
          revisions.reduce((sum, revision) => sum + revision.attempts, 0),
      },
      review: reviewed.review,
      reviewModel: reviewed.model,
      accepted: audit.valid && reviewed.review.verdict === "accept",
    };
  }

  if (!options.designFile) {
    throw new Error(`--design-file is required for ${options.mode} mode.`);
  }
  const artifact = await readDesignArtifact(options.designFile);
  const { pack } = artifact;
  const audit = auditWeeklyPackDesign({
    pack,
    graph: fixture.graph,
    context: fixture.context,
  });

  if (options.mode === "audit") {
    return {
      mode: options.mode,
      fixture: fixture.id,
      pack,
      audit,
    };
  }

  if (!audit.valid) {
    throw new Error(
      `Research refused because the design failed: ${audit.errors
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }
  if (!options.allowPaidResearch) {
    throw new Error(
      "Research starts three paid Parallel runs. Re-run with --allow-paid-research to confirm.",
    );
  }
  if (!artifact.review || artifact.review.verdict !== "accept") {
    throw new Error(
      "Research refused because the design file does not contain an accepted independent review.",
    );
  }
  return {
    mode: options.mode,
    requestId: randomUUID(),
    fixture: fixture.id,
    pack,
    research: await researchWeeklyPack({ fixture, pack }),
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await run(options);
    const rendered =
      "help" in result && typeof result.help === "string"
        ? result.help
        : JSON.stringify(result, null, 2);
    console.log(rendered);
    if (options.outputFile) {
      const outputPath = await writeResult(options.outputFile, result);
      console.error(`Wrote ${outputPath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
