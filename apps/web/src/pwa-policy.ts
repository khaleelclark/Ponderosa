export const PWA_NAVIGATION_DENYLIST = [
  /^\/api(?:\/|$)/u,
  /^\/__ponderosa_bootstrap(?:\.js)?(?:\/|$)/u,
];

export function pwaNavigationFallbackAllowed(pathname: string): boolean {
  return !PWA_NAVIGATION_DENYLIST.some((pattern) => pattern.test(pathname));
}
