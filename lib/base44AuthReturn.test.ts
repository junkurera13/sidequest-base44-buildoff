import { describe, expect, it } from "vitest";

import {
  readBase44AuthReturnPath,
  safeBase44AuthReturnOrigin,
  safeBase44AuthReturnPath,
} from "./base44AuthReturn";

describe("safeBase44AuthReturnOrigin", () => {
  it.each([
    ["http://localhost:3000/api/apps/auth/final-callback", "http://localhost:3000"],
    ["http://127.0.0.1:3000/api/apps/auth/final-callback", "http://127.0.0.1:3000"],
  ])("keeps a trusted local callback on its origin", (requestUrl, origin) => {
    expect(safeBase44AuthReturnOrigin(requestUrl)).toBe(origin);
  });

  it.each([
    "https://chapter-buildoff.vercel.app/api/apps/auth/final-callback",
    "https://sidequest-b44.vercel.app/api/apps/auth/final-callback",
    "http://localhost:4000/api/apps/auth/final-callback",
    "http://localhost.attacker.example:3000/api/apps/auth/final-callback",
    "not a url",
  ])("canonicalizes every other callback to production", (requestUrl) => {
    expect(safeBase44AuthReturnOrigin(requestUrl)).toBe(
      "https://chapter-buildoff.vercel.app",
    );
  });
});

describe("safeBase44AuthReturnPath", () => {
  it("keeps a short-code invitation on this app", () => {
    expect(safeBase44AuthReturnPath("/i/K7M2QX9RTP")).toBe("/i/K7M2QX9RTP");
  });

  it("still keeps a long-token invitation handed out before short codes", () => {
    const path = `/invite/${"a".repeat(43)}`;
    expect(safeBase44AuthReturnPath(path)).toBe(
      path,
    );
  });

  it.each([
    "https://attacker.example/invite/token",
    "//attacker.example/invite/token",
    "/app",
    "/invite\\attacker.example",
    "/invite/short",
    `/invite/${"a".repeat(43)}/../app`,
    "https://attacker.example/i/K7M2QX9RTP",
    "//attacker.example/i/K7M2QX9RTP",
    "/i/K7M2QX9RT",
    "/i/K7M2QX9RTPX",
    "/i/k7m2qx9rtp",
    "/i/K7M2QX9RTI",
    "/i/K7M2QX9RTP/../app",
    undefined,
  ])("rejects unsafe or unrelated return paths", (path) => {
    expect(safeBase44AuthReturnPath(path)).toBeNull();
  });
});

describe("readBase44AuthReturnPath", () => {
  const token = "a".repeat(48);

  function setCookie(value: string) {
    Object.defineProperty(globalThis, "document", {
      value: { cookie: value },
      configurable: true,
    });
  }

  it("returns the invitation saved before sign-in", () => {
    setCookie(`chapter_auth_return=${encodeURIComponent(`/invite/${token}`)}`);
    expect(readBase44AuthReturnPath()).toBe(`/invite/${token}`);
  });

  it("finds the cookie among others", () => {
    setCookie(
      `ph_session=abc; chapter_auth_return=${encodeURIComponent(`/invite/${token}`)}; theme=dark`,
    );
    expect(readBase44AuthReturnPath()).toBe(`/invite/${token}`);
  });

  it("refuses a path that isn't an invitation", () => {
    setCookie(`chapter_auth_return=${encodeURIComponent("https://evil.example")}`);
    expect(readBase44AuthReturnPath()).toBeNull();
  });

  it("is null when nothing is pending", () => {
    setCookie("theme=dark");
    expect(readBase44AuthReturnPath()).toBeNull();
  });
});
