import "server-only";

import { createFalClient } from "@fal-ai/client";
import { z } from "zod";

import type {
  WeeklyPackCardDesign,
  WeeklyPackResearchFinding,
} from "./weeklyPackDesign";

const OPENROUTER_IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";
const PACK_IMAGE_MODEL_ID =
  process.env.CHAPTER_PACK_IMAGE_MODEL || "krea/krea-2-large";
const PACK_IMAGE_PROMPT_VERSION = "chapter-environment-v1";
const IMAGE_TIMEOUT_MS = 120_000;

const openRouterImageResponseSchema = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string().min(16),
        media_type: z.string().optional(),
      }),
    )
    .min(1),
});

type ImageCopy = {
  title: string;
  promise: string;
};

type GeneratedBytes = {
  bytes: Uint8Array;
  mediaType: string;
};

export type WeeklyPackImageGenerationDependencies = {
  generate: (args: {
    modelId: string;
    prompt: string;
    requestId: string;
  }) => Promise<GeneratedBytes>;
  persist: (image: GeneratedBytes) => Promise<string>;
};

function generatedImageMediaType(value: string | undefined) {
  return value === "image/jpeg" || value === "image/webp"
    ? value
    : "image/png";
}

async function generateThroughOpenRouter(args: {
  modelId: string;
  prompt: string;
  requestId: string;
}): Promise<GeneratedBytes> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const response = await fetch(OPENROUTER_IMAGE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://chapter-buildoff.vercel.app",
      "X-Title": "Chapter",
      "X-Request-ID": args.requestId,
    },
    body: JSON.stringify({
      model: args.modelId,
      prompt: args.prompt,
      n: 1,
      resolution: "1K",
      aspect_ratio: "4:3",
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        require_parameters: true,
        zdr: true,
      },
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter image request failed (${response.status}).`);
  }

  const output = openRouterImageResponseSchema.parse(await response.json());
  const image = output.data[0];
  return {
    bytes: Uint8Array.from(Buffer.from(image.b64_json, "base64")),
    mediaType: generatedImageMediaType(image.media_type),
  };
}

async function persistOnFal(image: GeneratedBytes) {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error("FAL_KEY is not configured.");
  }

  const client = createFalClient({ credentials: apiKey });
  const ownedBuffer = new ArrayBuffer(image.bytes.byteLength);
  new Uint8Array(ownedBuffer).set(image.bytes);
  const blob = new Blob([ownedBuffer], { type: image.mediaType });
  return client.storage.upload(blob, {
    lifecycle: { expiresIn: "never" },
  });
}

const productionDependencies: WeeklyPackImageGenerationDependencies = {
  generate: generateThroughOpenRouter,
  persist: persistOnFal,
};

/**
 * The prompt receives only the finished, research-safe experience record.
 * Raw memories, graph anchors, relationships, feelings, and inferred personal
 * context never cross this boundary.
 */
export function buildWeeklyPackImagePrompt(args: {
  design: WeeklyPackCardDesign;
  finding: WeeklyPackResearchFinding;
  copy: ImageCopy;
}) {
  const sceneBrief = {
    experience: args.copy.promise,
    action: args.finding.experienceAction,
    environmentType: args.finding.experienceType,
    area: args.finding.primaryPlace?.area,
    routeOrSequence: args.finding.routeOrSequence,
    geography: args.design.format.geography,
    energy: args.design.format.energy,
    timeCharacter: args.design.format.timeCharacter,
  };

  return [
    "Create one photorealistic environmental photograph for a real-world experience card.",
    "The environment or place is the subject. Architecture, landscape, light, materials, and spatial atmosphere should fill the frame.",
    "Show no identifiable person, no face, and no posed human subject. When human presence is useful, imply it through an empty chair, tools, materials, a path, or a tiny distant incidental silhouette.",
    "",
    "VISUAL LANGUAGE",
    "- Premium Airbnb listing photography: clean, crisp, professional, naturally inviting, and aesthetically restrained.",
    "- Accurate natural light, balanced white balance, clear material texture, realistic depth, and gentle editorial contrast.",
    "- A considered wide or medium-wide composition with enough environmental detail to understand what it would feel like to arrive.",
    "- Calm, believable colour. No orange-and-teal cinema grade, heavy HDR, crushed blacks, haze, fantasy lighting, or hyper-saturation.",
    "- No readable text, typography, logos, watermarks, borders, collage, UI, or card mockup.",
    "- Do not invent a documentary image of a named venue. This is an honest visual interpretation of the kind of setting the experience inhabits.",
    "",
    `SCENE BRIEF: ${JSON.stringify(sceneBrief)}`,
    `PROMPT VERSION: ${PACK_IMAGE_PROMPT_VERSION}`,
  ].join("\n");
}

export async function generateWeeklyPackImage(
  args: {
    design: WeeklyPackCardDesign;
    finding: WeeklyPackResearchFinding;
    copy: ImageCopy;
    requestId: string;
  },
  dependencies: WeeklyPackImageGenerationDependencies = productionDependencies,
) {
  const prompt = buildWeeklyPackImagePrompt(args);
  const startedAt = Date.now();
  const image = await dependencies.generate({
    modelId: PACK_IMAGE_MODEL_ID,
    prompt,
    requestId: args.requestId,
  });
  const url = await dependencies.persist(image);

  console.info("[weekly-pack:image] generated", {
    requestId: args.requestId,
    cardId: args.design.id,
    model: PACK_IMAGE_MODEL_ID,
    promptVersion: PACK_IMAGE_PROMPT_VERSION,
    mediaType: image.mediaType,
    bytes: image.bytes.byteLength,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    url,
    alt: args.finding.primaryPlace?.area
      ? `A generated editorial view of a ${args.finding.experienceType} setting in ${args.finding.primaryPlace.area}`
      : `A generated editorial setting for ${args.copy.title}`,
    kind: "generated" as const,
  };
}
