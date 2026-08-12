export const BASE44_AUTH_RETURN_COOKIE = "chapter_auth_return";

const PRODUCTION_APP_ORIGIN = "https://chapter-buildoff.vercel.app";
const LOCAL_AUTH_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

export function safeBase44AuthReturnOrigin(requestUrl: string) {
  try {
    const requestOrigin = new URL(requestUrl).origin;
    return LOCAL_AUTH_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : PRODUCTION_APP_ORIGIN;
  } catch {
    return PRODUCTION_APP_ORIGIN;
  }
}

const INVITE_PATH = /^\/i\/[0-9A-HJ-NP-TV-Z]{10}$/;
/** Long-token links handed out before short codes. */
const LEGACY_INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{40,100}$/;

export function safeBase44AuthReturnPath(value: string | undefined) {
  if (!value) return null;
  return INVITE_PATH.test(value) || LEGACY_INVITE_PATH.test(value)
    ? value
    : null;
}

/**
 * The invite path saved before sign-in, if one is still pending.
 *
 * Authentication starts on the landing card, which otherwise always lands on
 * /app. An invitation has to survive that trip, so both the Google redirect
 * and the email form ask here for where to go back to.
 */
export function readBase44AuthReturnPath() {
  if (typeof document === "undefined") return null;

  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BASE44_AUTH_RETURN_COOKIE}=`));
  if (!entry) return null;

  try {
    return safeBase44AuthReturnPath(
      decodeURIComponent(entry.slice(BASE44_AUTH_RETURN_COOKIE.length + 1)),
    );
  } catch {
    return null;
  }
}

export function forgetBase44AuthReturnPath() {
  if (typeof document === "undefined") return;
  document.cookie = `${BASE44_AUTH_RETURN_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

export function rememberBase44AuthReturnPath(path: string) {
  const safePath = safeBase44AuthReturnPath(path);
  if (!safePath || typeof document === "undefined") return;

  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${BASE44_AUTH_RETURN_COOKIE}=${encodeURIComponent(safePath)}; Max-Age=600; Path=/; SameSite=Lax${secure}`;
}
