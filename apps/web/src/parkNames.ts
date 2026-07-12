// US National Parks and National Monuments used as memorable agent names.
// Keep the complete place name: multi-word names remain easy to mention because
// agentMentionHandle renders their spaces as hyphens (for example, #Bryce-Canyon).

const PARK_NAMES = [
  "Acadia",
  "American Samoa",
  "Arches",
  "Badlands",
  "Big Bend",
  "Biscayne",
  "Black Canyon of the Gunnison",
  "Bryce Canyon",
  "Canyonlands",
  "Capitol Reef",
  "Carlsbad Caverns",
  "Channel Islands",
  "Congaree",
  "Crater Lake",
  "Cuyahoga Valley",
  "Death Valley",
  "Denali",
  "Dry Tortugas",
  "Everglades",
  "Gates of the Arctic",
  "Gateway Arch",
  "Glacier",
  "Glacier Bay",
  "Grand Canyon",
  "Grand Teton",
  "Great Basin",
  "Great Sand Dunes",
  "Great Smoky Mountains",
  "Guadalupe Mountains",
  "Haleakala",
  "Hawaii Volcanoes",
  "Hot Springs",
  "Indiana Dunes",
  "Isle Royale",
  "Joshua Tree",
  "Katmai",
  "Kenai Fjords",
  "Kings Canyon",
  "Kobuk Valley",
  "Lake Clark",
  "Lassen Volcanic",
  "Mammoth Cave",
  "Mesa Verde",
  "Mount Rainier",
  "New River Gorge",
  "North Cascades",
  "Olympic",
  "Petrified Forest",
  "Pinnacles",
  "Redwood",
  "Rocky Mountain",
  "Saguaro",
  "Sequoia",
  "Shenandoah",
  "Theodore Roosevelt",
  "Virgin Islands",
  "Voyageurs",
  "White Sands",
  "Wind Cave",
  "Wrangell-St. Elias",
  "Yellowstone",
  "Yosemite",
  "Zion",
  // A selection of National Monuments adds variety without ambiguous fragments.
  "Bears Ears",
  "Bandelier",
  "Cabrillo",
  "Canyon de Chelly",
  "Cedar Breaks",
  "Craters of the Moon",
  "Devils Tower",
  "Dinosaur",
  "Fort Pulaski",
  "Grand Staircase-Escalante",
  "Hovenweep",
  "Jewel Cave",
  "Muir Woods",
  "Natural Bridges",
  "Organ Pipe Cactus",
  "Rainbow Bridge",
  "Scotts Bluff",
  "Sunset Crater Volcano",
  "Tonto",
  "Wupatki",
] as const;

/**
 * Pick a park-or-monument name not already used by an existing agent.
 * Comparison is case-insensitive. Falls back to a numbered suffix once the pool
 * is exhausted.
 */
export function pickAgentName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const available = PARK_NAMES.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]!;
  }
  // Pool exhausted — suffix a randomly selected place name.
  const base = PARK_NAMES[Math.floor(Math.random() * PARK_NAMES.length)]!;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
