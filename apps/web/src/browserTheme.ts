export type ColorMode = "light" | "dark";
export const COLOR_MODE_STORAGE_KEY = "ponderosa-color-mode";
export const THEME_BACKGROUNDS = {light: "#FBFCFB", dark: "#101312"} as const;

export function resolveColorMode(saved: unknown, prefersDark: boolean): ColorMode {
  return saved === "light" || saved === "dark" ? saved : prefersDark ? "dark" : "light";
}

/** The startup script and the resolved React theme use the same browser hints. */
export function applyBrowserTheme(mode: ColorMode, background: string): void {
  document.documentElement.style.colorScheme = mode;
  document.documentElement.style.backgroundColor = background;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", mode);
}

/** Emit a small self-contained, CSP-safe external script before deferred app code. */
export function browserThemeBootstrap(): string {
  return `(()=>{let saved;try{saved=window.localStorage.getItem(${JSON.stringify(COLOR_MODE_STORAGE_KEY)})}catch{}const mode=(${resolveColorMode.toString()})(saved,window.matchMedia?.("(prefers-color-scheme: dark)").matches??false);(${applyBrowserTheme.toString()})(mode,${JSON.stringify(THEME_BACKGROUNDS)}[mode]);})();`;
}
