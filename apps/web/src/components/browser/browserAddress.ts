/** Address bars accept either a website or a search, never executable schemes. */
export function browserAddress(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Enter a website or search term.");
  if (/^https?:\/\//i.test(text)) return new URL(text).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:\/|$)/i.test(text)) throw new Error("Use an http(s) website address or a search term.");
  if (!/\s/.test(text) && (/^(localhost|\[[a-f\d:]+\])(?::\d+)?(?:\/|$)/i.test(text) || /^[^/]+\.[^/]+/.test(text))) return new URL(`https://${text}`).href;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
