import { describe, expect, it } from "vitest";

import {
  getBase44AuthBridgeUrl,
  getBase44GoogleLoginUrl,
} from "./base44BrowserClient";

describe("getBase44GoogleLoginUrl", () => {
  it("builds a full-page login URL with the requested return", () => {
    const returnUrl = "http://localhost:3000/app";
    const loginUrl = new URL(getBase44GoogleLoginUrl(returnUrl));

    expect(loginUrl.origin + loginUrl.pathname).toBe(
      "https://base44.app/api/apps/auth/login",
    );
    expect(loginUrl.searchParams.get("from_url")).toBe(returnUrl);
    expect(loginUrl.searchParams.get("popup_origin")).toBeNull();
  });
});

describe("getBase44AuthBridgeUrl", () => {
  it("starts production OAuth from the Base44-owned app domain", () => {
    const returnUrl = "https://chapter-buildoff.vercel.app/app";
    const bridgeUrl = new URL(getBase44AuthBridgeUrl(returnUrl));

    expect(bridgeUrl.origin + bridgeUrl.pathname).toBe(
      "https://chapter-b44.base44.app/oauth-start",
    );
    expect(bridgeUrl.searchParams.get("return_url")).toBe(returnUrl);
  });
});
