import { beforeEach, describe, expect, it, vi } from "vitest";

const processSidequestMessage = vi.hoisted(() => vi.fn());
const markSidequestMessageDelivered = vi.hoisted(() => vi.fn());

vi.mock("./sidequestMessaging", () => ({
  processSidequestMessage,
  markSidequestMessageDelivered,
}));

import { handleSidequestDirectMessage } from "./sidequestBot";

function directMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    text: "Hey",
    author: { userId: "+821012345678" },
    raw: {
      direction: "inbound",
      content: { type: "text", text: "Hey" },
    },
    ...overrides,
  };
}

describe("handleSidequestDirectMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    processSidequestMessage.mockReset();
    markSidequestMessageDelivered.mockReset();
    vi.stubEnv("SIDEQUEST_AGENT_URL", "https://chapter-buildoff.vercel.app");
  });

  it("ignores unsupported empty content without sending a fallback", async () => {
    const post = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await handleSidequestDirectMessage(
      { id: "thread-1", post },
      directMessage({
        text: "",
        raw: {
          direction: "inbound",
          content: { type: "attachment", mimeType: "image/jpeg" },
        },
      }),
    );

    expect(processSidequestMessage).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("Ignored unsupported iMessage content", {
      messageId: "msg-1",
      direction: "inbound",
      contentType: "attachment",
    });
  });

  it("does not resend a reply for an already processed delivery", async () => {
    processSidequestMessage.mockResolvedValueOnce({
      reply: "Welcome back.",
      replyId: "reply-1",
      duplicate: true,
    });
    const post = vi.fn();

    await handleSidequestDirectMessage(
      { id: "thread-1", post },
      directMessage(),
    );

    expect(post).not.toHaveBeenCalled();
    expect(markSidequestMessageDelivered).not.toHaveBeenCalled();
  });

  it("sends and records one fresh reply", async () => {
    processSidequestMessage.mockResolvedValueOnce({
      reply: "Welcome to Chapter.",
      replyId: "reply-1",
    });
    const post = vi.fn().mockResolvedValueOnce({ id: "provider-1" });
    markSidequestMessageDelivered.mockResolvedValueOnce({ delivered: true });

    await handleSidequestDirectMessage(
      { id: "thread-1", post },
      directMessage(),
    );

    expect(processSidequestMessage).toHaveBeenCalledWith({
      phone: "+821012345678",
      text: "Hey",
      messageId: "msg-1",
      threadId: "thread-1",
      origin: "https://chapter-buildoff.vercel.app",
    });
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("Welcome to Chapter.");
    expect(markSidequestMessageDelivered).toHaveBeenCalledWith({
      replyId: "reply-1",
      providerMessageId: "provider-1",
    });
  });
});
