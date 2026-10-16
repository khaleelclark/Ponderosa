export class AuthenticationRequired extends Error {}
export function applicationUrl(raw: string): URL {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  if (["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com"].includes(hostname) ||
      /(?:^|[\/_.-])(?:login|signin|sign-in|oauth|authorize|authentication|password|mfa|sso)(?:$|[\/_.-])/i.test(url.pathname)) {
    throw new AuthenticationRequired("Paused for manual sign-in. Resume browser access in the extension when finished.");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("This page cannot be automated. Open an HTTPS website.");
  return url;
}
export function serverOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use your Ponderosa HTTPS address, without a page path.");
  return url.origin;
}
