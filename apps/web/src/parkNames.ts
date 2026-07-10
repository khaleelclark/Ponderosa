// Single-word US National Park names used as short, taggable agent handles.
// Single words keep @-mentions unambiguous and trivial to parse. When all names
// are taken within a project, we suffix a number (e.g. "Yosemite 2").

const PARK_NAMES = [
  "Yosemite",
  "Yellowstone",
  "Zion",
  "Denali",
  "Acadia",
  "Olympic",
  "Sequoia",
  "Everglades",
  "Glacier",
  "Badlands",
  "Redwood",
  "Arches",
  "Bryce",
  "Saguaro",
  "Shenandoah",
  "Katmai",
  "Kobuk",
  "Congaree",
  "Biscayne",
  "Pinnacles",
  "Voyageurs",
  "Canyonlands",
  "Capitol",
  "Wind",
  "Mesa",
  "Petrified",
  "Joshua",
  "Lassen",
  "Kenai",
  "Gateway",
  "Haleakala",
  "Channel",
  "Guadalupe",
  "Carlsbad",
  "Rainier",
  "Crater",
  "Isle",
  "Grand",
  "Great",
  "Hot",
  "Dry",
  "Big",
] as const;

/**
 * Pick a park-name handle not already used by an existing agent. Comparison is
 * case-insensitive. Falls back to a numbered suffix once the pool is exhausted.
 */
export function pickAgentName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const available = PARK_NAMES.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]!;
  }
  // Pool exhausted — suffix the least-recently-numbered park.
  const base = PARK_NAMES[Math.floor(Math.random() * PARK_NAMES.length)]!;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
