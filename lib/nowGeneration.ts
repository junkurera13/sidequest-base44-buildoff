import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";

import type { ExperienceGraphRecord } from "./backendTypes";
import {
  auditChapterShape,
  chooseChapterShape,
  seededChapterRandom,
  type ChapterDimension,
} from "./chapterEquation";
import {
  type NowBrief,
  nowBriefSchema,
  type NowChapterContent,
  nowComposedSchema,
  type NowEvidenceLink,
  type NowResearchFinding,
  nowResearchFindingSchema,
  NOW_DEFAULT_REACH,
  NOW_REACH,
  NOW_TIME_WINDOW_HOURS,
  type NowReach,
  type NowTimeWindow,
} from "./nowChapterSchema";
import { formatWeekday } from "./nowSchedule";

const NOW_MODEL_ID =
  process.env.CHAPTER_NOW_MODEL || "moonshotai/kimi-k2.6";
const NOW_FALLBACK_MODEL_ID =
  process.env.CHAPTER_NOW_FALLBACK_MODEL || "deepseek/deepseek-v4-flash";
/**
 * For calls a person is sitting and waiting on. Reasoning about where two
 * people should spend an afternoon deserves the larger model; writing one
 * sentence about what they already have in common does not, and Together
 * opens at the speed of whichever model writes it.
 */
const CHAPTER_QUICK_MODEL_ID =
  process.env.CHAPTER_QUICK_MODEL || "deepseek/deepseek-v4-flash";

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

export class NowGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NowGenerationError";
  }
}

type DigestNode = {
  id: string;
  category: string;
  label: string;
  salience: number;
  certainty: string;
};

/** Compact, bounded view of the graph the brief model reasons over. */
export function buildGraphDigest(graph: ExperienceGraphRecord, maxNodes = 60) {
  const nodes: DigestNode[] = [...graph.nodes]
    .sort((first, second) => second.salience - first.salience)
    .slice(0, maxNodes)
    .map((node) => ({
      id: node.id,
      category: node.category,
      label: node.label,
      salience: Math.round(node.salience * 100) / 100,
      certainty: node.certainty,
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter(
      (edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
    )
    .map((edge) => ({
      from: edge.fromNodeId,
      to: edge.toNodeId,
      relation: edge.relation,
    }));
  return { nodes, edges };
}

/**
 * The day someone set aside, written the way a researcher can act on it: the
 * weekday decides whether a place is even open, and the window decides which
 * hours of it to prove. A schedule that never reached the brief would be a
 * calendar entry; this is what makes it change what gets found.
 */
function whenClause(scheduledFor?: string, timeWindows?: readonly NowTimeWindow[]) {
  if (!scheduledFor) return "";
  const windows = timeWindows ?? [];
  const hours = windows
    .map((window) => `${window} (${NOW_TIME_WINDOW_HOURS[window]})`)
    .join(" or ");
  return [
    `- BE OPEN AND WORTH GOING TO on ${formatWeekday(scheduledFor)} ${scheduledFor}${
      hours ? `, during: ${hours}` : ""
    }.`,
    "  This is fixed. Verify the opening hours cover it from a source; if the best candidate is closed then, find a different one rather than moving the day.",
    windows.length > 0
      ? `  Let the window shape the find, not just filter it: what is worth doing at ${windows[0]} is not what is worth doing at another hour.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * How far someone will travel is not a filter laid over the answer, it is the
 * scale the whole search happens at.
 *
 * A fifteen minute walk forces the hyperlocal, which is where the good ones
 * are: the single-proprietor, odd-hours, no-English-signage places only exist
 * at neighbourhood scale, and a search that cannot leave those streets has to
 * find them. Two hours out has to say plainly that it means somewhere else,
 * or it returns the same city again with a looser bound on it.
 */
function reachClause(homeCity: string, reach: NowReach) {
  const { travel } = NOW_REACH[reach];
  if (reach === "beyond") {
    return [
      `- START from ${homeCity} and deliberately reach past it: the find must lie within ${travel} of there, and must NOT be in ${homeCity} itself.`,
      "  Somewhere that is a journey in its own right — a coast town, a mountain village, a valley temple — and say how it is reached.",
    ].join("\n");
  }
  if (reach === "walk") {
    return [
      `- CONSTRAIN the search to within ${travel} of ${homeCity}.`,
      "  This is a neighbourhood-scale search. The answer is a door on those streets, not a better place across the city, and somewhere further away is a wrong answer however good it is.",
    ].join("\n");
  }
  return `- CONSTRAIN the search to within ${travel} of ${homeCity}. Somewhere further away is a wrong answer, however good it is.`;
}

export function buildBriefPrompt(args: {
  graph: ExperienceGraphRecord;
  homeCity: string;
  avoidVenues?: readonly string[];
  declineReason?: string;
  /** The day already set aside, when this chapter grew out of a schedule. */
  scheduledFor?: string;
  timeWindows?: readonly NowTimeWindow[];
  reach?: NowReach;
  /** Pre-drawn by code in production; optional only for prompt unit tests. */
  twistDimension?: "place" | "activity" | "person" | "interest";
}) {
  const digest = buildGraphDigest(args.graph);
  const when = whenClause(args.scheduledFor, args.timeWindows);
  return [
    "You design one real-world experience proposal with one truthful influence from a private memory graph.",
    "Use the graph as a light influence, not a biography to reenact. Transform one strong thread without making the whole proposal about the person's past.",
    args.twistDimension
      ? `The Chapter Equation has already drawn the primary twist: ${args.twistDimension}. Keep that exact dimension as the one meaningful leap. Do not swap it for another kind of novelty.`
      : "The Chapter Equation uses one primary unfamiliar twist from place, activity, person, or interest.",
    "",
    "Design the human action before the place. Then write a research brief for a deep-research agent that will find the real, current infrastructure needed to make that action livable.",
    "At this design stage, do not invent or name a venue, event, provider, route, address, or timetable. Describe what research must prove; research supplies the real noun.",
    "The researchObjective must:",
    reachClause(args.homeCity, args.reach ?? NOW_DEFAULT_REACH),
    "- preserve the designed action, rhythm, or constraint instead of reducing the answer to a venue.",
    "- describe what to find in specific sensory and practical terms (atmosphere, materials, sound, pace, access).",
    "- demand uncommonness: prefer old, small, family-run, single-proprietor, odd-hours, hyperlocal places; explicitly exclude chains, franchises, tourist landmarks, and anything prominent in top-10 listicles or heavy English press.",
    "- require proof the place still operates (recent reviews, posts, or listings).",
    when || "- state the day/time window that suits the thread.",
    args.avoidVenues && args.avoidVenues.length > 0
      ? `- exclude these previously proposed venues: ${args.avoidVenues.join("; ")}.`
      : "",
    args.declineReason
      ? `The person declined the previous proposal because: "${args.declineReason}". Design a different action within the pre-drawn twist that answers that objection.`
      : "",
    "",
    "Set basis to `graph`. Anchors must reference 1-4 real node ids from the graph digest.",
    "GRAPH DIGEST (private)",
    JSON.stringify(digest),
  ]
    .filter(Boolean)
    .join("\n");
}

function anchorsExistingIn(graph: ExperienceGraphRecord, brief: NowBrief) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const anchors = brief.anchors.flatMap((anchor) => {
    const node = byId.get(anchor.nodeId);
    return node
      ? [{ nodeId: node.id, label: node.label, category: node.category }]
      : [];
  });
  return anchors;
}

/**
 * One structured model call with a fallback model behind it. Shared with
 * Together, which runs the same two-stage pipeline over two graphs.
 */
export async function generateStructured<T>(args: {
  prompt: string;
  schemaName: string;
  schemaDescription: string;
  schema: z.ZodType<T>;
  requestId: string;
  signal?: AbortSignal;
  /** Log surface, so Together's calls are legible in the same stream. */
  surface?: "now" | "together";
  /** Someone is watching a spinner for this one. Write it with the fast model. */
  quick?: boolean;
}): Promise<T> {
  const surface = args.surface ?? "now";
  if (!process.env.OPENROUTER_API_KEY) {
    throw new NowGenerationError("OPENROUTER_API_KEY is not configured.");
  }
  const modelIds = args.quick
    ? [CHAPTER_QUICK_MODEL_ID, NOW_MODEL_ID]
    : [NOW_MODEL_ID, NOW_FALLBACK_MODEL_ID];
  for (const [attempt, modelId] of modelIds.entries()) {
    const startedAt = Date.now();
    try {
      const result = await generateText({
        model: openrouter(modelId),
        messages: [{ role: "user", content: args.prompt }],
        output: Output.object({
          name: args.schemaName,
          description: args.schemaDescription,
          schema: args.schema,
        }),
        reasoning: "none",
        temperature: 0.4,
        maxOutputTokens: 3_000,
        maxRetries: 0,
        timeout: { totalMs: 45_000 },
        abortSignal: args.signal,
      });
      const value = args.schema.parse(result.output);
      console.info(`[${surface}:generate] structured call completed`, {
        requestId: args.requestId,
        schemaName: args.schemaName,
        attempt: attempt + 1,
        model: modelId,
        elapsedMs: Date.now() - startedAt,
      });
      return value;
    } catch (error) {
      console.warn(`[${surface}:generate] structured call failed`, {
        requestId: args.requestId,
        schemaName: args.schemaName,
        attempt: attempt + 1,
        model: modelId,
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  throw new NowGenerationError(
    `Chapter could not complete ${args.schemaName}.`,
  );
}

/** Stage 1: fill the pre-drawn thread and primary twist, then brief research. */
export async function generateNowBrief(args: {
  graph: ExperienceGraphRecord;
  homeCity: string;
  avoidVenues?: readonly string[];
  declineReason?: string;
  scheduledFor?: string;
  timeWindows?: readonly NowTimeWindow[];
  reach?: NowReach;
  requestId: string;
  signal?: AbortSignal;
}): Promise<NowBrief> {
  const random = seededChapterRandom(args.requestId);
  const anchorCandidates = [
    ...new Set(
      args.graph.nodes.flatMap((node) =>
        node.category === "place" ||
        node.category === "activity" ||
        node.category === "interest"
          ? [node.category]
          : [],
      ),
    ),
  ] as ChapterDimension[];
  const shape = chooseChapterShape({
    company: "self",
    random,
    anchorCandidates,
    allowContext: false,
  });
  const shapeIssues = auditChapterShape(shape);
  if (shapeIssues.length > 0) {
    throw new NowGenerationError(
      `Chapter could not draw a legal Now shape (${shapeIssues
        .map((issue) => issue.code)
        .join(", ")}).`,
    );
  }
  const twistDimension =
    shape.twist === "people" ? "person" : shape.twist;
  const briefSchema = nowBriefSchema.extend({
    stretch: z.object({
      dimension: z.literal(twistDimension),
      description: z.string().min(10).max(300),
    }),
  });
  const brief = await generateStructured({
    prompt: buildBriefPrompt({ ...args, twistDimension }),
    schemaName: "now_brief",
    schemaDescription:
      "An experience thread that follows its pre-drawn Chapter shape, with a deep-research objective.",
    schema: briefSchema,
    requestId: args.requestId,
    signal: args.signal,
  });

  const anchors = anchorsExistingIn(args.graph, brief);
  if (anchors.length === 0) {
    throw new NowGenerationError(
      "The brief did not anchor to real graph nodes.",
    );
  }
  if (
    shape.anchor &&
    !anchors.some((anchor) => anchor.category === shape.anchor)
  ) {
    throw new NowGenerationError(
      `The brief did not use its pre-drawn ${shape.anchor} anchor.`,
    );
  }
  return { ...brief, basis: "graph", anchors };
}

export function buildComposePrompt(args: {
  brief: NowBrief;
  finding: NowResearchFinding;
  homeCity: string;
  scheduledFor?: string;
  timeWindows?: readonly NowTimeWindow[];
}) {
  const windows = args.timeWindows ?? [];
  return [
    "Write the one line on a Chapter card: a friend asking whether somebody wants to do a specific thing at a specific place.",
    "Voice: a thoughtful friend texting. Warm, plain, unhurried. No marketing language, no exclamation marks, no emoji.",
    "",
    "Rules:",
    "- line: ONE sentence, at most 20 words. It names the activity and the venue and nothing else.",
    "- The line must contain the `activity` string and the venue name VERBATIM, because the app draws those as chips by finding them in it.",
    `- Use the venue name exactly as researched: ${args.finding.venue_name}`,
    "- activity: 2 to 8 words for the thing itself, lower case unless it is a proper noun. Never the venue name, never a whole sentence.",
    /*
     * The hard rule, and the reason this prompt exists in this shape. Anything
     * said about the person is unverifiable by the time it reaches the screen,
     * so nothing may be said about them at all. Why this was chosen for them is
     * carried by the anchors, which are real nodes out of their own graph, and
     * the card shows those separately as its sources.
     */
    "- Say NOTHING about the person. No claims about their past, their family, their habits, what they have done or felt or would like. No 'you loved', no 'like the one you went to', no second-guessing why this suits them. The card shows their memories separately; the line is only the offer.",
    "- Do not describe the venue beyond what a friend would say in passing. No adjectives borrowed from reviews.",
    args.scheduledFor
      ? "- The day is settled, so state it rather than asking about it, and put it in `when` exactly as it appears in the line."
      : "- If the line names a day or a time of day, put that phrase in `when` exactly as it appears in the line. Otherwise leave `when` empty.",
    "",
    "Good: How about a ceramics class at Sungjae Studio in Euljiro this Saturday afternoon?",
    "Bad: Because you loved the pottery you made with your grandmother, how about...",
    "",
    `HOME CITY: ${args.homeCity}`,
    args.scheduledFor
      ? `THE DAY: ${formatWeekday(args.scheduledFor)} ${args.scheduledFor}${
          windows.length > 0 ? `, ${windows.join(" or ")}` : ""
        }`
      : "",
    "THE STRETCH (what makes this worth offering, for your judgement only — never say it):",
    JSON.stringify(args.brief.stretch),
    "RESEARCH FINDING (verified):",
    JSON.stringify(args.finding),
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseGroundedNowResearch(args: {
  researchContent: unknown;
  citations: readonly NowEvidenceLink[];
}) {
  const finding = nowResearchFindingSchema.safeParse(args.researchContent);
  if (!finding.success) {
    throw new NowGenerationError(
      "Research did not prove a named place, address, and current operation.",
    );
  }
  if (args.citations.length === 0) {
    throw new NowGenerationError(
      "Research returned no source for the real-world place.",
    );
  }
  const name = finding.data.venue_name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (
    /^(a |an |the ).*\b(site|venue|place|location|facility|park|event|route|class|studio)$/.test(
      name,
    ) ||
    /^(local |nearby |public |municipal )?(screening )?(site|venue|place|location|facility|park|event|route|class|studio)$/.test(
      name,
    )
  ) {
    throw new NowGenerationError(
      "Research returned a generic description instead of a real named place.",
    );
  }
  const proof = [
    finding.data.venue_name,
    finding.data.address,
    finding.data.still_operating_evidence,
    finding.data.best_time,
    finding.data.price_note ?? "",
  ].join(" ");
  if (
    /\b(no qualifying|could not (?:be )?verified|could not verify|not (?:a )?verified|unable to verify|no (?:current |supporting )?(?:proof|evidence) (?:was )?found|(?:best|closest) (?:available|documented) (?:option|candidate),? but|disqualified)\b/i.test(
      proof,
    )
  ) {
    throw new NowGenerationError(
      "Research named a place but did not prove the promised activity there.",
    );
  }
  return finding.data;
}

/** Stage 3: turn the verified research finding into the chapter proposal. */
export async function composeNowChapter(args: {
  brief: NowBrief;
  researchContent: unknown;
  citations: NowEvidenceLink[];
  homeCity: string;
  scheduledFor?: string;
  timeWindows?: readonly NowTimeWindow[];
  requestId: string;
  signal?: AbortSignal;
}): Promise<{ content: NowChapterContent; evidence: NowEvidenceLink[] }> {
  const finding = parseGroundedNowResearch(args);

  const composed = await generateStructured({
    prompt: buildComposePrompt({
      brief: args.brief,
      finding,
      homeCity: args.homeCity,
      scheduledFor: args.scheduledFor,
      timeWindows: args.timeWindows,
    }),
    schemaName: "now_chapter",
    schemaDescription: "The one line on the card, and the chips inside it.",
    schema: nowComposedSchema,
    requestId: args.requestId,
    signal: args.signal,
  });

  /*
   * The chips are found by looking for these strings in the line. A model that
   * paraphrased itself would leave the card with a name it cannot draw, so the
   * ones that went missing are dropped rather than rendered against nothing.
   */
  return {
    content: {
      ...composed,
      activity: composed.line.includes(composed.activity)
        ? composed.activity
        : "",
      when: composed.when && composed.line.includes(composed.when)
        ? composed.when
        : "",
      venueName: finding.venue_name,
      venueArea: finding.venue_area,
      address: finding.address,
      bestTime: finding.best_time,
      priceNote: finding.price_note ?? undefined,
    },
    evidence: args.citations.slice(0, 4),
  };
}
