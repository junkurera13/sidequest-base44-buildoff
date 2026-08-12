# Chapter Buildoff

Chapter Buildoff begins by learning from one experience a person will never forget.
It meets them in iMessage, turns that experience into a private graph of
people, places, activities, feelings, and patterns, and lets them explore that
growing picture in the authenticated **You** view.

That private world is then used for something. Every Saturday, **Now** opens a
pack of three independently researched experiences: one small activity, one
mini adventure, and one proper adventure. The person may reveal all three and
keep one. **Together** plans for two connected people only from what their
worlds turn out to share.

This is the Base44 Backend Build-Off edition. Base44 owns authentication,
private file storage, account-to-phone linking, conversations, autobiographical
memory sources, graph validation, connection invites, and persistence. Named
people become distinct nodes, and a private connection invite can link two
authenticated accounts without exposing either person's memories.

## Live app

- Frontend: https://chapter-buildoff.vercel.app
- Base44 app ID: `6a606ec9966ada5a7874da07`

Open `/app` to see the authenticated product and private **You** world.

## Current product flow

```text
Google sign-in -> Base44 account + private uploads
                         |
                         v
web / iMessage <-> Next.js <-> Eve <-> OpenRouter
                         |
                         v
              Base44 conversation + memory graph
                         |
          +--------------+---------------+
          v                              v
        Now                          Together
  home city + graph            named private invites
          |                    + bounded account-pool scan
  optional accepted companion              |
          |                    strict shared anchors only
  compose small / mini / proper            |
          |                    server attaches first name
  3 independent research runs              |
          |                    opening message -> recipient accepts
  lock until local Saturday                |
          |                    reciprocal nodes + private message thread
  reveal three -> keep one                 |
          |                                v
  schedule -> lived             gist -> research -> propose -> lived
```

## Models

Chapter calls 2026 models through OpenRouter, and Parallel AI for web research.
Application generation choices are environment-overridable. Eve's two
conversation models are currently fixed in `agent/agent.ts`.

| Path | Model | Override |
| --- | --- | --- |
| Onboarding memory extraction (multimodal) | `google/gemini-3.1-flash-lite`, falling back to `moonshotai/kimi-k2.6` | `CHAPTER_MEMORY_MODEL`, `CHAPTER_MEMORY_FALLBACK_MODEL` |
| Eve conversation (web + iMessage) | `deepseek/deepseek-v4-flash` for text, `moonshotai/kimi-k2.6` for image-bearing turns | none |
| Weekly-pack design and final card copy | `openai/gpt-5.6-terra`, with bounded deterministic retries | `CHAPTER_PACK_MODEL`, `CHAPTER_PACK_COMPOSITION_MODEL` |
| Weekly-pack environmental images | OpenRouter Image API with `krea/krea-2-large`; durable media on fal CDN | `CHAPTER_PACK_IMAGE_MODEL` |
| Together briefs, chapters and legacy Now fallback | `moonshotai/kimi-k2.6`, falling back to `deepseek/deepseek-v4-flash` | `CHAPTER_NOW_MODEL`, `CHAPTER_NOW_FALLBACK_MODEL` |
| Together gists and introduction lines | `deepseek/deepseek-v4-flash` | `CHAPTER_QUICK_MODEL` |
| Weekly-pack research | Parallel AI `core` processor | `CHAPTER_PACK_PROCESSOR`, falling back to `CHAPTER_NOW_PROCESSOR` |
| Legacy Now / Together research | Parallel AI `core` processor | `CHAPTER_NOW_PROCESSOR` |

OpenRouter calls are pinned to zero-data-retention providers with
`data_collection: "deny"`.

The product owner's account has one server-enforced testing affordance in the
real **Now** surface: its orb can start a fresh stored three-card pack at any
time. The result uses the same reveal, choice, scheduling, and chosen-experience
states as an ordinary Saturday pack. No other account receives the control or
can invoke its paid generation actions.

## How the pieces fit

- `sidequest-data` handles authenticated session ownership, phone-account
  linking, private graph retrieval, connection invites, reciprocal nodes, home
  city, weekly-pack preparation/release state, and Together chapter records.
- Eve owns the durable Chapter conversation. The same Eve session continues
  across the web and iMessage. Onboarding extraction does **not** go through
  Eve. It calls OpenRouter directly so the first memory never depends on the
  agent sandbox.
- `sidequest-memory` preserves text and private-image sources before extraction,
  signs short-lived image URLs, then validates and persists the result.
- `sidequest-message` deduplicates inbound messages, stores Eve's opaque session
  cursor, and records reply delivery.
- Photon is used only as the bridge between Apple Messages and the signed
  Next.js webhook. Base44 remains the source of truth.
- The deployed Base44 resource IDs retain their pre-rebrand `sidequest-*`
  slugs as compatibility contracts. They are internal identifiers, not product
  branding.
- Fourteen Base44 entities hold accounts, Chapter conversations, human
  messages, memories, source memories,
  graph nodes, graph edges, connection invites, accepted connections,
  introductions, weekly experience packs, Now chapters, Together chapters, and
  the content-free realtime inbox signals Together subscribes to.
- A connection records how it began. An invite means the two people found each
  other by name; an introduction means Chapter noticed a strict overlap, one
  person sent an opening message, and the recipient accepted it.
- Raw invite tokens are never persisted. Base44 stores only a SHA-256 hash,
  and an accepted token links exact user IDs rather than guessing from names.

### What Together is allowed to say

Together reduces each private graph to a shareable cut of places, activities,
and interests only. Feelings, people, conditions, patterns, and the memories
themselves never leave the server.

A **gist** is narrower still: it reveals only the intersection of the two
worlds, so every sentence is already true on both sides. Composition is the
initiator's job alone; the partner polls the same endpoint but cannot see or
advance a draft, and so cannot spend a research run they don't know exists.

An **introduction** is a named gist about someone you have not met. The model
sees only the strict shared anchors and a person token; Base44 attaches the
correct first name separately for each reader. The card carries no photograph,
one-sided fact, answer state, or compatibility score. Either person may send
one opening message. Only its recipient sees the message, and accepting it
creates an ordinary connection, reciprocal people nodes, and a private human
message thread. Declining closes the offer without reporting the response.

There is currently no opt-in screen. Eligible accounts take part by default,
and anyone may mute introductions, which withdraws every live offer involving
them. The pool scan is bounded, opens only a limited number of candidate
graphs, and returns only strict shared labels to the trusted application route;
the other graph never leaves Base44.

## Local development

Requires Node.js 24, a Base44 account, an OpenRouter API key, a Parallel AI key
for Now/Together research, and a `SIDEQUEST_INTERNAL_SECRET` for Eve's internal
channel. Authenticated web memory requests use the signed-in Base44 session;
production-only phone and internal requests still require the deployed
backend's matching compatibility secret.

```bash
npm install
npm run dev
```

Ordinary local development intentionally leaves Eve disabled. Onboarding memory
extraction calls OpenRouter directly and does not require Eve. Local Eve must
only be enabled explicitly while diagnosing or testing its sandbox runtime:

```bash
CHAPTER_ENABLE_LOCAL_EVE=1 npm run dev
```

Production builds continue to include Eve for messaging. For local release
verification without Eve or its sandbox runtime, use `npm run build:safe`. The
local dev command uses webpack because the Turbopack compiler is not stable
with Chapter's current landing bundle.

The app defaults to the deployed competition backend. To point it at another
Base44 app:

```bash
NEXT_PUBLIC_BASE44_APP_ID=your_app_id npm run dev
```

Runtime secrets: `OPENROUTER_API_KEY`, `PARALLEL_API_KEY`, `FAL_KEY`,
`SIDEQUEST_INTERNAL_SECRET`, `IMESSAGE_WEBHOOK_SECRET`, and the Photon /
iMessage project credentials. Never commit these values.

Production also requires `CRON_SECRET`.
`CHAPTER_WEEKLY_PACKS_PER_RUN` bounds how many eligible accounts the daily
worker may begin.
Optional demo gists are controlled only by the server-side
`CHAPTER_DEMO_ACCOUNTS` allowlist; account emails must never be placed in a
`NEXT_PUBLIC_` variable.

## Verification

```bash
npm run lint
npm test
npm run build
npx eve info --json
npx eve channels list --json
```

`npm test` currently runs 369 tests across 51 files.

The production pass should additionally verify Google sign-in, phone linking,
the iMessage webhook health route, one real memory turn, private graph
retrieval, a Saturday pack from three research runs through reveal and choice,
a two-account connection acceptance, a Together gist and chapter across two
accounts, and mobile overflow.

See [`BUILD_JOURNAL.md`](./BUILD_JOURNAL.md) for the build history.
