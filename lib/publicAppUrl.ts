const PRODUCTION_APP_ORIGIN = "https://chapter-buildoff.vercel.app";

export function publicInviteUrl(code: string) {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  const origin = configuredOrigin || PRODUCTION_APP_ORIGIN;
  return new URL(`/i/${encodeURIComponent(code)}`, origin).toString();
}
