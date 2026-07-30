/*
  WorldObjects.ts
  ───────────────
  Single source of truth for every interactable landmark in RugTown.

  This module is intentionally framework-agnostic (no Phaser import) so it
  can be referenced by anything that cares about "where things are and what
  they are" — WorldScene's interaction-zone detection today, and future
  quest triggers, NPC pathing/dialogue, ambient sound zones, and landmark
  icons/animations, without any of those systems needing to know about each
  other or duplicate coordinates.

  Phase 9C — Final master world (949×1024, 1:1 with
  RugTown_World_Master_Final_Upscaled.png). Landmark fractions below match
  NewCanonicalWorld.LANDMARK_ANCHORS (image-pixel first-pass calibration).
  Interaction radii are scaled down for the smaller world while keeping
  the same landmark ids and LIVE_INTERACTION_IDS contract.

  Coordinates are fractions (0–1) of world width/height. Use
  `toWorldPosition()` once worldW/worldH are known.
*/

/* ─── Interaction category ───
   Semantic meaning for each landmark — useful for future systems (quests,
   NPC dialogue, sound, animation) to branch on "what kind of place is this"
   independently of whether a live interaction is wired up yet. */
export type InteractionType =
  | 'reward'        // grants the player something on interact
  | 'discovery'     // reveals information/content on interact
  | 'leaderboard'   // shows a ranking/standings view
  | 'travel'        // notice about movement/travel between areas
  | 'alert'         // ambient alert / notification flavor
  | 'social'        // social/gathering hub
  | 'notice'        // announcements / community board
  | 'rest'          // rest stop / buff spot
  | 'scenic'        // ambient/scenic, no functional payload
  | 'locked';       // building exists but is locked until future activation

export interface WorldObject {
  id: string;
  displayName: string;
  /** Fraction of world width, 0–1 */
  x: number;
  /** Fraction of world height, 0–1 */
  y: number;
  /** Trigger radius in world px */
  interactionRadius: number;
  interactionType: InteractionType;
  /** Flavor text for not-yet-built features (quests, dialogue, tooltips) */
  futureDescription: string;
  /** Placeholder icon for future signposts/minimap/quest UI */
  futureIcon: string;
}

/* ─── Registry ───
   Every interactable landmark in RugTown. Adding a new landmark means
   adding one entry here — nothing else should hardcode a position.

  Phase 10A main_rugtown.png (2172×724). Fractions from V4 landmark anchors. */
export const WORLD_OBJECTS: WorldObject[] = [
  // ── Centre (Spring Water plaza) ──
  {
    id: 'fountain',
    displayName: 'Spring Water',
    x: 0.3485,
    y: 0.4392,
    interactionRadius: 90,
    interactionType: 'reward',
    futureDescription: 'Toss a coin for good luck and claim a small REP reward. Future updates may add daily streaks and seasonal wishes.',
    futureIcon: '⛲',
  },
  {
    id: 'notice',
    displayName: 'Notice Board',
    x: 0.1289,
    y: 0.6492,
    interactionRadius: 70,
    interactionType: 'notice',
    futureDescription: 'Community notices and event announcements. Planned for a future quest/events update.',
    futureIcon: '📌',
  },
  {
    id: 'coffee',
    displayName: 'Coffee Shop',
    x: 0.4144,
    y: 0.5939,
    interactionRadius: 70,
    interactionType: 'rest',
    futureDescription: 'A cozy spot to rest and catch up on city gossip. Planned for a future NPC dialogue and buff update.',
    futureIcon: '☕',
  },
  // ── Upper terrace / teal roofs ──
  {
    id: 'fame',
    displayName: 'Hall of Fame',
    x: 0.1105,
    y: 0.3867,
    interactionRadius: 90,
    interactionType: 'leaderboard',
    futureDescription: "A monument to RugTown's top degens. Future updates may add a live leaderboard and seasonal inductions.",
    futureIcon: '🏛️',
  },
  {
    id: 'government',
    displayName: 'Government Quarter',
    x: 0.1565,
    y: 0.1934,
    interactionRadius: 70,
    interactionType: 'discovery',
    futureDescription: 'Civic offices overseeing RugTown affairs. Planned for a future governance/voting update.',
    futureIcon: '🏙️',
  },
  {
    id: 'trading_academy',
    displayName: 'Trading Academy',
    x: 0.221,
    y: 0.4282,
    interactionRadius: 70,
    interactionType: 'discovery',
    futureDescription: 'Lessons on reading charts and surviving the market. Planned for a future tutorial/education update.',
    futureIcon: '🎓',
  },
  // ── Northeast civic / towers ──
  {
    id: 'whale',
    displayName: 'Whale Tower',
    x: 0.6998,
    y: 0.2072,
    interactionRadius: 85,
    interactionType: 'alert',
    futureDescription: 'A watchtower for tracking large wallet movements. Future updates may add a live whale-alert feed.',
    futureIcon: '🐳',
  },
  {
    id: 'financial_office',
    displayName: 'Financial Office',
    x: 0.7274,
    y: 0.3867,
    interactionRadius: 75,
    interactionType: 'discovery',
    futureDescription: 'Where RugTown keeps its books straight-ish. Planned for a future treasury/reporting update.',
    futureIcon: '💼',
  },
  {
    id: 'holder_bank',
    displayName: 'Holder Bank',
    x: 0.7919,
    y: 0.3591,
    interactionRadius: 75,
    interactionType: 'discovery',
    futureDescription: 'A vault for long-term holders. Planned for a future staking/yield update.',
    futureIcon: '🏦',
  },
  {
    id: 'research_observatory',
    displayName: 'Research Observatory',
    x: 0.0368,
    y: 0.221,
    interactionRadius: 70,
    interactionType: 'discovery',
    futureDescription: 'Analysts scanning the charts for the next signal. Planned for a future analytics update.',
    futureIcon: '🔭',
  },
  // ── Southeast market ──
  {
    id: 'market',
    displayName: 'Meme Market',
    x: 0.5433,
    y: 0.3315,
    interactionRadius: 90,
    interactionType: 'discovery',
    futureDescription: 'Stalls trading the latest meme tokens. Future updates may add live price tickers and trading mini-games.',
    futureIcon: '🛒',
  },
  {
    id: 'market_shop',
    displayName: 'Market Shop',
    x: 0.6077,
    y: 0.3591,
    interactionRadius: 70,
    interactionType: 'discovery',
    futureDescription: 'A single trader\'s stall just off the main hall. Planned for a future inventory/trading update.',
    futureIcon: '🏪',
  },
  {
    id: 'tournament_hall',
    displayName: 'Tournament Hall',
    x: 0.9438,
    y: 0.1657,
    interactionRadius: 75,
    interactionType: 'discovery',
    futureDescription: 'Where challengers sign up before stepping into the Arena. Planned for a future PvP/bracket update.',
    futureIcon: '🥇',
  },
  {
    id: 'arena',
    displayName: 'Future Arena',
    x: 0.9576,
    y: 0.3867,
    interactionRadius: 100,
    interactionType: 'discovery',
    futureDescription: 'The grand arena of RugTown. Future tournaments, championships, and live events will be hosted here.',
    futureIcon: '🏟️',
  },
  // ── West / Southwest ──
  {
    id: 'alpha',
    displayName: 'Alpha Lounge',
    x: 0.3131,
    y: 0.5525,
    interactionRadius: 80,
    interactionType: 'social',
    futureDescription: 'An exclusive lounge for alpha calls and private chat. Planned for a future social/chat update.',
    futureIcon: '🛋️',
  },
  {
    id: 'nft_gallery',
    displayName: 'NFT Gallery',
    x: 0.5571,
    y: 0.663,
    interactionRadius: 75,
    interactionType: 'discovery',
    futureDescription: 'A curated wall of RugTown\'s finest pixel art. Planned for a future gallery/minting update.',
    futureIcon: '🖼️',
  },
  {
    id: 'nft_creator_studio',
    displayName: 'NFT Creator Studio',
    x: 0.9392,
    y: 0.6215,
    interactionRadius: 70,
    interactionType: 'discovery',
    futureDescription: 'A workshop for degens minting their own collections. Planned for a future creator-tools update.',
    futureIcon: '🎨',
  },
  {
    id: 'park',
    displayName: 'Park Entrance',
    x: 0.9669,
    y: 0.8564,
    interactionRadius: 75,
    interactionType: 'scenic',
    futureDescription: 'A quiet green corner of RugTown. Planned for a future ambient sound and idle-animation update.',
    futureIcon: '🌳',
  },
  // ── Southern connectors ──
  {
    id: 'bridge',
    displayName: 'Main Bridge',
    x: 0.8748,
    y: 0.5249,
    interactionRadius: 75,
    interactionType: 'travel',
    futureDescription: 'Crossing point into neighboring districts. Future updates may unlock fast travel and new zones beyond it.',
    futureIcon: '🌉',
  },
  {
    id: 'cashback',
    displayName: 'Holder Cashback Vault',
    x: 0.7274,
    y: 0.732,
    interactionRadius: 90,
    interactionType: 'locked',
    futureDescription: 'Holder Cashback Vault — locked until $RUGTOWN activation.',
    futureIcon: '🔒',
  },
];

/* ─── Lookups ─── */
export function getWorldObject(id: string): WorldObject | undefined {
  return WORLD_OBJECTS.find(o => o.id === id);
}

/** Fractional (x,y) → real world pixels, once worldW/worldH are known. */
export function toWorldPosition(obj: WorldObject, worldW: number, worldH: number): { wx: number; wy: number } {
  return { wx: obj.x * worldW, wy: obj.y * worldH };
}

/* ─── Live interaction set ───
   Landmarks with a real interaction wired up today (proximity prompt +
   modal). Everything else in WORLD_OBJECTS is registered and ready for
   future quests/NPCs/sounds/animations to reference, but isn't triggered
   by the player yet. Expanding a landmark's interaction later means
   adding its id here — no coordinate or detection-logic changes needed. */
/** Every major landmark is intentionally interactive (modal / door / locked state). */
const LIVE_INTERACTION_IDS = new Set(WORLD_OBJECTS.map((o) => o.id));

export function isLiveInteractionId(id: string): boolean {
  return LIVE_INTERACTION_IDS.has(id);
}

export function isInteractionLive(obj: WorldObject): boolean {
  return LIVE_INTERACTION_IDS.has(obj.id);
}

export function getLiveWorldObjects(): WorldObject[] {
  return WORLD_OBJECTS.filter(isInteractionLive);
}
