import Phaser from 'phaser';
import { getLiveWorldObjects, getWorldObject, toWorldPosition, WORLD_OBJECTS } from '../world/WorldObjects';
import { CollisionSystem } from '../systems/CollisionSystem';
import { InteractionSystem } from '../systems/InteractionSystem';
import { BuildingGenerator } from '../worldEngine/BuildingGenerator';
import { DecorationGenerator } from '../worldEngine/DecorationGenerator';
import { WorldTerrainLayer } from '../worldEngine/WorldTerrainLayer';
import { NewWorldDebugOverlay } from '../worldEngine/NewWorldDebugOverlay';
import { CompactWorldAmbience } from '../systems/CompactWorldAmbience';
import { CompactRoadRenderer } from '../worldEngine/CompactRoadRenderer';
import { clearMinimapData, getMinimapData, addMinimapRoad, addMinimapBuilding } from '../worldEngine/WorldMinimapData';
import {
  WORLD_W as NEW_WORLD_W, WORLD_H as NEW_WORLD_H,
  SPAWN_X as NEW_SPAWN_X, SPAWN_Y as NEW_SPAWN_Y,
  FOUNTAIN_X as NEW_FOUNTAIN_X, FOUNTAIN_Y as NEW_FOUNTAIN_Y,
  CAMERA_ZOOM_DEFAULT, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX,
  WORLD_COLLISION_ENABLED, PLAYER_SPEED as CANONICAL_PLAYER_SPEED,
  spawnPointForSlot,
  buildWalkableRects as buildNewWalkableRects,
  type CanonicalBuildingPlot,
} from '../world/NewCanonicalWorld';
import { WorldCameraController } from '../camera/WorldCameraController';
import { ellipsizeName, layoutNameplates, type NameplateSlot } from '../ui/NameplateLayout';
import type { MinimapEventMarker, MinimapLiveSnapshot } from '../minimap/MinimapTypes';
import {
  formatInteractPrompt,
  PRIORITY,
  resolveInteractTarget,
  type InteractCandidate,
} from '../interaction/InteractionTargetResolver';
import {
  buildLandmarkCatalog,
  type LandmarkMeta,
} from '../interaction/LandmarkCatalog';
import {
  PLAYER_FACING_CONE,
  PLAYER_INTERACT_RADIUS,
  isPresenceStale,
  presenceToSocialSummary,
} from '../../lib/social';
import { getDistrictAtWorld, WORLD_DISTRICTS } from '../world/WorldDistricts';
import { MissionSystem, createStarterMissionSystem } from '../systems/MissionSystem';
import { MissionEventBridge, setActiveMissionBridge } from '../missions/MissionEventBridge';
import type { GameplayEvent } from '../missions/MissionTypes';
import { getNpcByLandmark } from '../npcs/FunctionalNpcs';
import { loadProgress, patchProgress } from '../../lib/progress';
import {
  buildEnterableDoorZones,
  getEnterableBuilding,
  getWorldReturnPosition,
  type ResolvedDoorZone,
} from '../world/EnterableBuildings';
import { InteriorScene } from './InteriorScene';
import { EventManager } from '../events/EventManager';
import { EVENT_DEFINITIONS } from '../events/EventDefinitions';
import type { EventDefinition, EventInstance, EventPhase } from '../events/EventTypes';
import { soundManager } from '../../audio/SoundManager';
import { queueWorldCharacterLoads } from '../characters/assets/CharacterAssetLoader';
import { hydrateCharacterRegistryFromScene, listNpcBodies, assetExists } from '../characters/assets/CharacterAssetRegistry';
import { charPerfMark, charPerfMeasure } from '../characters/dev/CharacterPerfMarks';
import { BitmapCharacter, npcAppearanceFromId } from '../characters/render/BitmapCharacter';
import {
  PLAYER_VISUAL_SCALE, REMOTE_PLAYER_VISUAL_SCALE, NPC_VISUAL_SCALE,
  TARGET_DISPLAY_HEIGHT,
} from '../characters/render/CharacterVisualScale';
import type { CharacterAppearanceV1 } from '../characters/appearance/CharacterAppearanceDefaults';
import { getDefaultCharacterAppearance } from '../characters/appearance/CharacterAppearanceDefaults';
import { decodeCharacterAppearance, encodeCharacterAppearance } from '../characters/appearance/CharacterAppearanceCodec';
import type { Direction } from '../characters/animation/CharacterDirection';
import {
  FOOT_COLLIDER_W, FOOT_COLLIDER_H, FOOT_OFFSET_Y,
} from '../systems/CollisionSystem';
import type { PresencePayload } from '../../lib/presence';
import { getDistrictForLandmark, getRandomDistrictLine } from '../world/NpcDistrictDialogue';
import { ROAD_EDGES } from '../world/RoadNetwork';

/** Footprint used for movement clamps / hit tests (not bitmap render size). */
const CHAR_W = 22;
const CHAR_H = 34;

function coerceAppearanceV1(appearance: unknown): CharacterAppearanceV1 {
  return decodeCharacterAppearance(appearance, assetExists);
}

/** Phase 9C — standalone landmark PNGs are no longer overlaid; the final
 *  master already bakes buildings into the terrain. Kept only as a comment
 *  reference for the five former test asset paths. */
const FIVE_TEST_BUILDING_ASSETS: Record<string, string> = {
  fame:   'landmarks/hall_of_fame.png',
  market: 'landmarks/meme_market_main_hall.png',
  whale:  'landmarks/whale_tower.png',
  coffee: 'landmarks/coffee_shop.png',
  arena:  'landmarks/arena.png',
};

/** Live citizen population — 3× the previous calibration count (11 → 33).
 *  Culling, speech caps, and staggered spawn keep frame cost stable. */
const CALIBRATION_NPC_COUNT = 33;

/** Phase 8K Task 9 — NPC nameplates hide beyond this distance from the
 *  player; the local player's own label is always shown regardless. */
const NPC_LABEL_VISIBLE_RADIUS = 400;

/** Phase 8K Task 10 — at most this many city-event banners/messages are
 *  visible over the plaza at once (a short FIFO queue, not deleted). */
const MAX_VISIBLE_EVENT_MESSAGES = 1;

/*
  WorldScene.ts — Player Movement + NPC Citizens Edition
  ─────────────────────────────────────────
  Procedural world (3600×2400, Phase 8B compact). Spawn at Spring Water,
  the exact world centre (50% x, 50% y).
  Player + NPCs are pixel-art humanoids; camera follows with smooth lerp.
  Public API: panTo, setTargetZoom, getPlayerPos, teleportTo
*/

/* ─── Tuning constants ─── */
// Phase 9C — world size derives from NewCanonicalWorld.ts (1:1 with
// RugTown_World_Master_Final_Upscaled.png native 949×1024).
const DEFAULT_WORLD_W   = NEW_WORLD_W;
const DEFAULT_WORLD_H   = NEW_WORLD_H;

// Player movement — instant velocity, delta-timed, frame-rate independent.
// Phase 10B: 252 → 176 (−30%). Canonical constant lives in WorldMapScale.
const PLAYER_SPEED      = CANONICAL_PLAYER_SPEED;
const PLAYER_DIAG       = 0.7071;       // diagonal normalization

// Zoom — Phase 10B practical band (controller also enforces cover-floor).
const ZOOM_MIN          = CAMERA_ZOOM_MIN;
const ZOOM_MAX          = CAMERA_ZOOM_MAX;
const ZOOM_STEP         = 0.08;
const ZOOM_DEFAULT      = CAMERA_ZOOM_DEFAULT;

// Phase 9C — Spring Water sits at LANDMARK_ANCHORS.fountain on the final
// master; player spawns just south of the basin on plaza paving
// (NewCanonicalWorld.SPAWN_X/Y), not inside the fountain.
const SPAWN_FX          = NEW_SPAWN_X / NEW_WORLD_W;
const SPAWN_FY          = NEW_SPAWN_Y / NEW_WORLD_H;

// Turn smoothing — player
const LEAN_MAX            = 0.11;   // radians (~6°) max lean
const LEAN_SMOOTH         = 0.12;   // per-frame lerp factor for the lean

// Emote "pop" animation — a brief squash/stretch pulse layered on top of
// the player's existing breathing scale, doesn't touch movement at all
const EMOTE_PULSE_DURATION = 500;   // ms

/* ─── NPC tuning ─── */
const NPC_SCALE           = NPC_VISUAL_SCALE;
const NPC_ALPHA           = 0.94;   // clearer on screen
// Phase 11C: 0.25s → 0.45s. NPCs snapped to full speed almost
// instantly, which read as "stiff/robotic"; the longer ramp makes
// starts and stops feel like a citizen choosing to walk rather than a
// switch flipping.
const NPC_ACCEL_TIME      = 0.45;
/** Phase 11C — brief "look before you walk" beat inserted between a
 *  finished pause and the start of the next walk (Task 14 lookAround). */
const NPC_LOOK_AROUND_MS  = 380;
/** Phase 11C — minimum time between facing changes; prevents the
 *  diagonal-velocity jitter where facing flickered between two cardinal
 *  directions frame to frame while accelerating near a 45° heading. */
const NPC_FACING_MIN_INTERVAL_MS = 220;
/** Phase 11C Task 17 — lightweight personal-space separation. Cheap:
 *  O(n²) over the current ~11-citizen population is trivial; would need
 *  a spatial grid well before this became a real cost. */
const NPC_PERSONAL_SPACE_RADIUS = 24;
const NPC_SEPARATION_PUSH = 55; // px/s of extra lateral velocity when crowded
const NPC_ARRIVE_DIST     = 6;      // px — close enough to call it "arrived"
const NPC_LEAN_MAX        = 0.09;
const NPC_LEAN_SMOOTH     = 0.10;
const NPC_SPEECH_MIN_GAP  = 7000;   // ms between ONE NPC's own speech attempts (min)
const NPC_SPEECH_MAX_GAP  = 18000;  // ms between ONE NPC's own speech attempts (max)
const NPC_SPEECH_DURATION = 3200;   // ms a speech bubble stays visible
const NPC_SPEECH_CHANCE   = 0.55;   // odds a given attempt actually shows a line
const NPC_SPEECH_MAX_VISIBLE = 4;   // hard cap on simultaneous citizen speech bubbles (any source)
const NPC_LABEL_NEAR_RADIUS = 70;   // px — close-encounter radius; names are hidden by default (see updateNpcs)
/** HiDPI-aware text backing resolution — keeps nameplates sharp on phones. */
const WORLD_TEXT_RESOLUTION = Math.min(3, Math.max(2, Math.round(
  (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1,
)));
/** Sans-serif nameplates stay legible at small sizes; Cinzel blurs on mobile. */
const NAMEPLATE_FONT = 'Segoe UI, Helvetica Neue, Arial, sans-serif';

/* ─── Phase 8H — compact-world population model ───
   Centralizes the tuning that's specific to rebalancing NPC population for
   the 3600×2400 world (as opposed to the animation/rendering constants
   above, which aren't world-size-dependent). Population/district
   allocation is deterministic (NPC_HOME_LANDMARKS below); only per-NPC
   flavor (name/appearance/exact jitter/timing) still varies per session. */
const COMPACT_NPC_CONFIG = {
  /** Total citizens — matches CALIBRATION_NPC_COUNT (33 = 3× prior 11). */
  totalPopulation: 33,
  /** Nothing may idle/spawn closer than this to Spring Water (1800,1200). */
  spawnClearanceRadius: 130,
  /** Max NPCs simultaneously within the bridge plaza radius (Task 13). */
  bridgeCapacity: 2,
  /** Chance a 'roamer' re-homes to an ADJACENT (road-connected) district
   *  on each pause, instead of staying local (Task 8: ~15-25% cross-district).
   *  Phase 8J Task 11: forced to 0 — the old landmark-graph re-homing code
   *  (updateNpcs) still reads WORLD_OBJECTS/ROAD_ADJACENCY, which is stale
   *  for the new background; disable it rather than let NPCs re-home onto
   *  old-world coordinates outside the confirmed-walkable plaza. */
  crossDistrictChance: 0,
  /** NPC walk speed range, px/s.
   *  Phase 11C audit: PLAYER_SPEED is now 176 (WorldMapScale.ts), but this
   *  range was last tuned against the OLD 252 player speed and never
   *  revisited — speedMax (195) was actually FASTER than the current
   *  player (176), which is exactly the "NPCs feel too fast" complaint.
   *  OLD: speedMin 145, speedMax 195 (up to 111% of player speed).
   *  NEW: speedMin 62, speedMax 108 (35–61% of player speed) — every
   *  citizen is now visibly slower than the player during ordinary
   *  wandering. District/behavior multipliers (NPC_DISTRICT_SPEED_MULT
   *  below) scale within this range; even the busiest market multiplier
   *  (1.2) tops out at 130, still 26% under the player. */
  speedMin: 62,
  speedMax: 108,
} as const;
const NPC_SPEED_MIN = COMPACT_NPC_CONFIG.speedMin;
const NPC_SPEED_MAX = COMPACT_NPC_CONFIG.speedMax;

/** Phase 11C Task 16 — per-district speed/pause feel. Keyed by the REAL
 *  WorldDistricts.ts district ids (west / spring_core / east / financial
 *  / arena_grounds) — the only districts that actually exist as geometry
 *  today. The prompt's named districts (Market/Government/Park/Coffee/
 *  Bridge) don't have 1:1 geometry yet, so this maps the closest real
 *  district to the intended feel: spring_core = fountain gatherings,
 *  east = the busiest/market-like band, financial = deliberate/office
 *  pace, west = slow/residential-ish, arena_grounds = purposeful. */
const NPC_DISTRICT_SPEED_MULT: Record<string, number> = {
  spring_core: 0.85,
  east: 1.2,
  financial: 0.72,
  west: 0.68,
  arena_grounds: 0.9,
};
const NPC_DISTRICT_PAUSE_MULT: Record<string, number> = {
  spring_core: 1.15,
  east: 0.8,
  financial: 1.35,
  west: 1.4,
  arena_grounds: 1.0,
};

/** Deterministic district-weighted home assignment (Task 4) — one entry
 *  per citizen, in spawn order. Reuses the same 8-district grouping as
 *  CompactWorldAmbience.ts's DISTRICT_GROUPS for consistency. Counts:
 *  plaza 3, government 2, market 5, financial 5, creator 2, arena 2,
 *  park 1, waterfront 2 = 22 (COMPACT_NPC_CONFIG.totalPopulation). */
const NPC_HOME_LANDMARKS: string[] = [
  'fountain', 'fountain', 'notice', 'coffee', 'coffee',
  'fame', 'government', 'government',
  'market', 'market', 'market', 'market', 'market_shop', 'market_shop', 'market_shop',
  'whale', 'financial_office', 'financial_office', 'holder_bank', 'research_observatory', 'alpha', 'alpha',
  'nft_gallery', 'nft_creator_studio', 'nft_gallery',
  'arena', 'tournament_hall', 'arena',
  'park', 'park',
  'bridge', 'cashback', 'bridge',
];

/** landmarkId -> directly road-connected landmarkIds (one hop), built once
 *  from ROAD_EDGES — keeps roamer cross-district movement following actual
 *  connected roads (Task 8) instead of jumping to any random landmark. */
const ROAD_ADJACENCY: Record<string, string[]> = {};
for (const e of ROAD_EDGES) {
  (ROAD_ADJACENCY[e.a] ??= []).push(e.b);
  (ROAD_ADJACENCY[e.b] ??= []).push(e.a);
}

// Redraw citizens + remote players at ~20fps max (every 50ms). Their
// geometry rebuild is the dominant per-frame cost with a crowd on screen;
// capping at 20fps frees the main thread while movement stays smooth.
// NPCs move at a modest fraction of player speed (COMPACT_NPC_CONFIG),
// so 20fps animation is imperceptibly different from 30fps at normal play
// distance.
const CHAR_DRAW_INTERVAL = 50;

// Ambient speech bubbles also get pushed into the city chat panel, but
// that must NOT scale with population — this is a single GLOBAL cooldown
// shared by all citizens, independent of how many of them exist.
const NPC_CHAT_GLOBAL_COOLDOWN = 6500; // slightly longer with denser crowds

/* ─── Personalities ───
   Drives outfit, speech pool, and correlated display names. */
export type NpcPersonality = 'degen' | 'whale' | 'alpha' | 'trader' | 'informant' | 'builder' | 'memelord';

const NPC_PERSONALITIES: NpcPersonality[] = ['degen', 'whale', 'alpha', 'trader', 'informant', 'builder', 'memelord'];

/* ─── RugTown citizen names by personality ───
   Names are drawn from the personality pool so a whale looks/reads like a
   whale and a trader reads like a trader — not a random mash of slang. */
const NPC_NAMES_BY_PERSONALITY: Record<NpcPersonality, string[]> = {
  degen: [
    'Degen Dave', 'Rekt Ricky', 'Ape Andy', 'Cope Carl', 'Hopium Hazel',
    'Paper Paula', 'Moonboy Max', 'Jeet Jerry', 'Dip Buyer Bea', 'Bag Goblin',
  ],
  whale: [
    'Whale Wren', 'Big Bag Ben', 'Quiet Quinn', 'Ledger Lane', 'Vault Vera',
    'Deep Pocket Pat', 'Silent Sybil', 'Reserve Remy', 'Titan Tess', 'Oracle Owen',
  ],
  alpha: [
    'Alpha Aisha', 'Signal Sage', 'Chart Chad', 'Edge Ezra', 'Scout Selene',
    'Tipster Tia', 'Radar Rhea', 'Pulse Parker', 'Early Elise', 'Callen Cole',
  ],
  trader: [
    'Trader Trent', 'Slippage Sam', 'Liquidity Larry', 'Spread Serena', 'Order Owen',
    'Bid Bella', 'Ask Avery', 'Floor Fay', 'Market Mia', 'Ticket Tess',
  ],
  informant: [
    'Informant Ivy', 'Rumour Rex', 'Whisper Will', 'Notice Nora', 'Courier Cade',
    'Ledger Lila', 'Hint Hank', 'Source Sybil', 'Brief Blake', 'Town Tess',
  ],
  builder: [
    'Builder Bram', 'Forge Felix', 'Scaffold Sam', 'Mortar Maya', 'Beam Bella',
    'Plaza Piper', 'Stone Sterling', 'Craft Casey', 'Arch Avery', 'Mason Milo',
  ],
  memelord: [
    'Meme Marlowe', 'Wagmi Wyatt', 'Based Bea', 'Fren Freddy', 'GM Gabby',
    'Probably Paz', 'Copium Cody', 'Laser Leo', 'Ser Serena', 'OG Oliver',
  ],
};

const NPC_NAME_FALLBACK = [
  'Citizen Cam', 'Plaza Pat', 'Bridge Betty', 'Fountain Finn', 'Market Mae',
  'Arena Ari', 'Tower Tate', 'Coffee Cole', 'Bank Bri', 'Park Piper',
];

function pickNpcName(personality: NpcPersonality, used: Set<string>): string {
  const pool = NPC_NAMES_BY_PERSONALITY[personality] ?? NPC_NAME_FALLBACK;
  const available = pool.filter((n) => !used.has(n));
  const source = available.length > 0 ? available : NPC_NAME_FALLBACK.filter((n) => !used.has(n));
  const name = source.length > 0
    ? Phaser.Utils.Array.GetRandom(source)
    : `${personality[0].toUpperCase()}${personality.slice(1)} ${used.size + 1}`;
  used.add(name);
  return name;
}

// Skin tone now lives in CharacterAppearance.ts's SKIN_TONES — picked as
// part of generateRandomAppearance() below, not a separate palette here.

export const NPC_SPEECH_BY_PERSONALITY: Record<NpcPersonality, string[]> = {
  degen: [
    'GM degens',
    'I bought the top again',
    'Sold the bottom last week',
    "Red candles don't scare me... much",
    "I'm not selling until zero",
    'Diamond hands, paper plans',
    "It'll come back. It always does",
    'Buy the dip, theoretically',
  ],
  whale: [
    'Big wallets move quietly',
    "I've seen things in the mempool",
    'Watch the wallets, not the charts',
    'Whale spotted near the tower',
    "I don't chase, I accumulate",
    'Liquidity looks healthy today',
    "Just moved a bag, don't ask",
    "Whales don't sleep",
  ],
  alpha: [
    'Real alpha is patience',
    'The best calls are quiet ones',
    "Don't chase, let it come to you",
    'That candle looks suspicious',
    'This pattern never lies',
    'Alpha Lounge is busy tonight',
    'Quiet alpha is the best alpha',
    'Position before the news, not after',
  ],
  trader: [
    'Meme Market is pumping',
    'Slippage is under control today',
    'Pools are looking deep tonight',
    'Spread is tight this morning',
    'Volume is picking up at the Market',
    'Liquidity looks healthy today',
    'Order book looks thin up here',
    'Buy low, panic sell high — works every time',
  ],
  informant: [
    'Trust no dev',
    'Always check the liquidity lock',
    "If it sounds too good, it's a rug",
    'Rug warning near Rug Alley',
    'Someone always exits first',
    'Every pump needs a dump',
    'Dev wallet just moved, watch out',
    'Contract looks unverified to me',
  ],
  builder: [
    'Still shipping, still building',
    'Code compiles, vibes immaculate',
    'Audits take time, be patient',
    'Mainnet soon, probably',
    'Builder Jacket, builder mindset',
    'Testnet looked good today',
    'Gas fees optimized this week',
    'Roadmap update coming soon',
  ],
  memelord: [
    'To the moon, eventually',
    'We are so back',
    'This is the way',
    'Probably nothing',
    'WAGMI, fren',
    'Patience is the real rocket fuel',
    'Number go up technology',
    'Ser, this whole town is a casino',
  ],
};

/* ─── Behavior types ───
   Tunes the existing idle/walk/pause wander loop per citizen rather
   than adding a new state machine — "idle"-leaning citizens just pause
   longer and wander less, "roamers" occasionally pick a brand new
   landmark as their home instead of always returning to the same one. */
export type NpcBehaviorType = 'idle' | 'wander' | 'gatherer' | 'roamer';

const NPC_BEHAVIOR_WEIGHTS: { type: NpcBehaviorType; weight: number }[] = [
  { type: 'idle',     weight: 25 },
  { type: 'wander',   weight: 40 },
  { type: 'gatherer', weight: 20 },
  { type: 'roamer',   weight: 15 },
];

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    if (r < item.weight) return item;
    r -= item.weight;
  }
  return items[items.length - 1];
}


// NPCs occasionally turn to face a nearby NPC when they pause
const NPC_FACE_RADIUS  = 70;         // px
const NPC_FACE_CHANCE  = 0.7;

// Talking to an NPC — same E key as landmarks, but landmark zones win
// if the player happens to be near both (see updateNpcProximity()).
const NPC_TALK_RADIUS = 50;          // px

// Opening the Treasure Hunt event's chest — same E key, lowest priority
// of the three (see updateTreasureProximity()).
const TREASURE_INTERACT_RADIUS = 60; // px

// Inspecting the Whale Alert event's marker — same E key/priority tier
// as the treasure chest (see updateWhaleProximity()). Treasure Hunt and
// Whale Alert can never be Live at the same time (EventManager only
// ever runs one event), so the two never compete for the prompt.
const WHALE_INTERACT_RADIUS = 60; // px

// Town Crier — appears during any event's Announcement phase.
const TOWN_CRIER_LINE_DURATION = 2600; // ms each speech-bubble line stays up
const TOWN_CRIER_FACE_RADIUS = 220;    // px — citizens within this radius briefly face him

// Inspecting a Hall of Fame statue — same E key, lowest priority (after
// landmark zones, NPCs, the treasure chest, and the whale marker).
const STATUE_INTERACT_RADIUS = 55; // px

// Rank-colored glow — gold/silver/bronze (req. 6).
const STATUE_RANK_COLOR: Record<number, number> = {
  1: 0xe8b84b,
  2: 0xc9d2da,
  3: 0xb5712b,
};

// Crowd reaction — speech bubbles for the larger wave of citizens
// converging on a major-event moment (req. 6).
const CROWD_REACTION_LINES = [
  'I heard something!',
  "Let's go!",
  'Where?',
  'Follow the crowd!',
  'This city is alive.',
];

/* ─── NPC state ─── */
// Phase 11C: added 'look' — a brief anticipation beat between a finished
// pause and the start of the next walk (Task 14: "occasionally turn
// their head before moving"). Navigation/collision/target-picking are
// unchanged; 'look' only holds the NPC still and re-faces it once.
type NpcState = 'idle' | 'walk' | 'pause' | 'look';

interface NpcData {
  name: string;
  px: number;
  py: number;
  velX: number;
  velY: number;
  facing: Direction;
  isMoving: boolean;
  speed: number;
  homeX: number;
  homeY: number;
  wanderRadius: number;
  targetX: number;
  targetY: number;
  state: NpcState;
  stateTimer: number;
  pauseMin: number;
  pauseMax: number;
  walkMin: number;
  walkMax: number;
  animTick: number;
  lean: number;
  personality: NpcPersonality;
  behaviorType: NpcBehaviorType;
  homeLandmarkIndex: number;
  /** Landmark id at homeLandmarkIndex — cached so roamer re-homing (Task 8)
   *  can look up road-adjacent landmarks by id without an array lookup. */
  homeLandmarkId: string;
  /** Phase 6 — district this citizen belongs to (derived from home landmark). */
  districtId: string;
  speechTimerNext: number;
  speechShowUntil: number;
  /** Small per-citizen jitter applied to speech-bubble position so
   *  several bubbles near each other don't perfectly overlap (req. D3). */
  speechOffsetX: number;
  speechOffsetY: number;
  /** Whether the player is currently within NPC_LABEL_NEAR_RADIUS —
   *  cached so the label's setText() only runs on actual state changes,
   *  not every frame (req. C). */
  labelNear: boolean;
  /** Blink timing — mirrors the speechTimerNext/speechShowUntil pattern
   *  already used above. */
  blinkTimerNext: number;
  blinkUntil: number;
  /** Phase 11C — ms-timestamp (animTick-relative) of the last facing
   *  change, so near-diagonal velocity can't flicker facing every frame. */
  lastFacingChangeMs: number;
  /** Phase 11C — target position queued during the 'look' anticipation
   *  beat, applied once 'look' finishes and 'walk' begins. */
  pendingTargetX: number;
  pendingTargetY: number;
  bitmap: BitmapCharacter;
  label: Phaser.GameObjects.Text;
  speech: Phaser.GameObjects.Text;
}

/** Phaser graphics + interpolation state for one remote real player. */
interface RemotePlayerEntry {
  glow:    Phaser.GameObjects.Graphics;
  bitmap:  BitmapCharacter;
  label:   Phaser.GameObjects.Text;
  speech:  Phaser.GameObjects.Text;   // emote bubble (hidden when idle)
  px:      number;     // current lerped world-pixel x
  py:      number;     // current lerped world-pixel y
  targetX: number;
  targetY: number;
  animTick: number;
  facing:  Direction;
  isMoving: boolean;
  /** Phase 8I — remote players now blink too, for animation-model parity
   *  with the local player/NPCs (Task 16). Purely visual/local; not
   *  synced over the network. */
  blinkTimerNext: number;
  blinkUntil: number;
  appearanceRev?: number;
  username: string;
  speechUntil:    number;   // ms until emote bubble hides
  emotePulseUntil: number;  // ms until emote pulse ends
  // Cached presence data — exposed via click event for the profile card
  presenceId:    string;
  rep:           number;
  holderTier:    string;
  rawAppearance: CharacterAppearanceV1;
  /** Phase 10F optional presence progression. */
  level?: number;
  rankLabel?: string;
  equippedTitle?: string;
  /** Client clock when presence last updated this entry. */
  lastSeenAt: number;
  /** Selected as interaction target — cyan ring accent. */
  selected: boolean;
}

export class WorldScene extends Phaser.Scene {

  /* ── World dimensions ── */
  private worldW = DEFAULT_WORLD_W;
  private worldH = DEFAULT_WORLD_H;

  /* ── Player ── */
  private player!: Phaser.GameObjects.Container;
  private bitmapPlayer: BitmapCharacter | null = null;
  private playerGlow!: Phaser.GameObjects.Graphics;   // depth below player
  private playerLabel!: Phaser.GameObjects.Text;
  private playerSpeech!: Phaser.GameObjects.Text;
  private playerSpeechUntil = 0;
  private emotePulseUntil = 0;
  private appearance: CharacterAppearanceV1 = getDefaultCharacterAppearance();
  /** Blink timing — same shape as the per-NPC fields. */
  private playerBlinkTimerNext = Phaser.Math.Between(2000, 6000);
  private playerBlinkUntil = 0;
  /** Last clamped frame delta (ms) — used when drawPlayer is called outside update. */
  private lastDeltaMs = 16;

  // Movement state
  private velX = 0;
  private velY = 0;
  private facing: Direction = 'down';
  private isMoving = false;
  private animTick = 0;                 // for glow / label timing
  private lean = 0;                     // smoothed body lean (turn smoothing)

  // World position
  private px = 0;
  private py = 0;
  /** Optional spawn override from session restore (set before create). */
  private pendingSpawn: { x: number; y: number } | null = null;

  /* ── NPC citizens ── */
  private npcs: NpcData[] = [];
  private npcLandmarks: { name: string; fx: number; fy: number; radius: number }[] = [];

  /* ── Remote real players (Realtime Presence) ── */
  private remotePlayerEntries = new Map<string, RemotePlayerEntry>();
  /** Global cross-citizen cooldown so ambient speech forwarded into the
   *  city chat panel doesn't scale (and spam) with population size. */
  private npcChatCooldownRemaining = 0;

  /** Accumulator that throttles the (expensive) citizen + remote-player
   *  geometry redraws to ~30fps. Their movement/state still updates every
   *  frame — only the Graphics re-tessellation is halved, which is the
   *  dominant sustained cost with a crowd on screen. */
  private charDrawAccum = 0;
  private charDrawThisFrame = true;

  /* ── NPC dialogue proximity ── */
  private nearNpcName: string | null = null;

  /* ── Mobile virtual controls (joystick + interact button) ──
     Both default to "nothing pressed" so desktop keyboard play is
     completely unaffected when nothing on mobile is touching them. */
  private virtualMoveX = 0;   // -1..1
  private virtualMoveY = 0;   // -1..1
  private virtualInteractRequested = false;

  /* ── Reward feedback (floating text above player) ── */
  private floatingTexts: { obj: Phaser.GameObjects.Text; vy: number; life: number; maxLife: number }[] = [];

  /* ── Plaza origin — used by event positioning (applyEventCitizenGather,
     pickTownCrierSpawnPosition, triggerLiveCrowdReaction) and the
     fallback randomWalkablePoint. Set in create() after worldW/H are known. ── */
  private plazaX = 0;
  private plazaY = 0;

  /* ── Phase 1 systems ── */
  private collision!: CollisionSystem;
  private interaction!: InteractionSystem;
  /** Phase 10B — single authoritative camera owner (no startFollow). */
  private worldCamera!: WorldCameraController;
  /** Phase 10D — landmark catalog + interaction debug. */
  private landmarkCatalog: LandmarkMeta[] = [];
  private lastInteractFeedbackAt = 0;
  private lockedFeedbackSpamMs = 1400;
  /** Phase 10E — sticky interaction target hysteresis. */
  private stickyInteractId: string | null = null;
  private stickyInteractSince = 0;
  private lastSocialCardOpenAt = 0;
  private socialCardCooldownMs = 450;
  private selectedRemotePlayerId: string | null = null;
  private mission: MissionSystem = createStarterMissionSystem();
  private missionBridge = new MissionEventBridge();
  /* ── Phase 4 World Engine generators ── */
  private buildingGenerator!: BuildingGenerator;
  private decorationGenerator!: DecorationGenerator;
  private compactAmbience?: CompactWorldAmbience;
  private compactRoadRenderer?: CompactRoadRenderer;
  /** Phase 8A — F9 architecture blueprint overlay (dev only). */
  private architectureOverlay: NewWorldDebugOverlay | null = null;
  /** Phase 8K Task 4 — actual placed anchor of each of the 5 test
   *  buildings, for the F9 calibration crosshair (plot vs sprite). */
  private testBuildingSprites: { plot: CanonicalBuildingPlot; anchorX: number; anchorY: number }[] = [];
  /* ── Phase 3 systems ── */
  private enterableDoors: ResolvedDoorZone[] = [];
  private nearDoorId: string | null = null;
  private interiorActive = false;

  /* ── Phase 5 gameplay loop / save ── */
  private visitedInteriors = new Set<string>();
  private currentDistrictName = '';
  private currentDistrictId: string | null = null;
  /** Landmark proximity hysteresis for first-visit discovery. */
  private landmarkDiscoverArmed = new Set<string>();
  private lastDiscoveryCheckAt = 0;

  /* ── Input ── */
  private keyW!:     Phaser.Input.Keyboard.Key;
  private keyA!:     Phaser.Input.Keyboard.Key;
  private keyS!:     Phaser.Input.Keyboard.Key;
  private keyD!:     Phaser.Input.Keyboard.Key;
  private keyUp!:    Phaser.Input.Keyboard.Key;
  private keyDown!:  Phaser.Input.Keyboard.Key;
  private keyLeft!:  Phaser.Input.Keyboard.Key;
  private keyRight!: Phaser.Input.Keyboard.Key;
  private keyZoomIn!:    Phaser.Input.Keyboard.Key;
  private keyZoomOut!:   Phaser.Input.Keyboard.Key;
  private keyZoomReset!: Phaser.Input.Keyboard.Key;
  private keyRecenter!:  Phaser.Input.Keyboard.Key;
  private keyE!:         Phaser.Input.Keyboard.Key;
  private keyEmote1!:     Phaser.Input.Keyboard.Key;
  private keyEmote2!:     Phaser.Input.Keyboard.Key;
  private keyEmote3!:     Phaser.Input.Keyboard.Key;
  private keyEmote4!:     Phaser.Input.Keyboard.Key;
  // keyC removed — collision debug is Settings-only in public demo

  /* ── Zoom ── */
  private targetZoom  = ZOOM_DEFAULT;
  private currentZoom = ZOOM_DEFAULT;
  /** Recomputed every frame so the world image always covers the
   *  viewport, on any screen size/orientation/fullscreen state. */
  private zoomMin = ZOOM_MIN;

  /* ── Misc ── */
  private tick = 0;               // ms accumulator for registry publish rate

  /* ── Event Engine (Phase 2) ──
     The reusable lifecycle engine (src/game/events/) — framework-agnostic,
     owns its own timers. WorldScene's job is just to: publish its state
     to the registry for React, and apply the three local "effects" an
     event can ask for (weather/music/citizen behaviour). Everything else
     about an event (rarity, rewards, dialogue) is pure data it carries. */
  private eventManager = new EventManager(EVENT_DEFINITIONS);
  private eventManagerUnsubscribe: (() => void) | null = null;
  private activeWeather: string | null = null;
  private weatherGraphics!: Phaser.GameObjects.Graphics;
  private rainDrops: { ox: number; oy: number; len: number; speed: number }[] = [];
  private eventGatherSnapshot: { npc: NpcData; homeX: number; homeY: number; wanderRadius: number }[] | null = null;

  /* ── Treasure Hunt chest — only ever exists while the 'treasure-hunt'
     definition is Live; spawned/despawned from handleEventPhaseChange. ── */
  private treasureChest: {
    wx: number;
    wy: number;
    glow: Phaser.GameObjects.Graphics;
    body: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  } | null = null;
  private nearTreasure = false;

  /* ── Whale Alert marker — only ever exists while the 'whale-alert'
     definition is Live; spawned/despawned from handleEventPhaseChange. ── */
  private whaleMarker: {
    wx: number;
    wy: number;
    glow: Phaser.GameObjects.Graphics;
    body: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  } | null = null;
  private nearWhale = false;

  /* ── Town Crier — only ever exists during the Announcement phase of
     ANY event (not tied to one definition id, unlike the chest/whale
     marker); spawned/despawned from handleEventPhaseChange. ── */
  private townCrier: {
    wx: number;
    wy: number;
    bitmap: BitmapCharacter;
    bell: Phaser.GameObjects.Text;
    label: Phaser.GameObjects.Text;
    speech: Phaser.GameObjects.Text;
    lines: string[];
    lineIndex: number;
    lineTimer: number;
    animTick: number;
  } | null = null;
  private nearTownCrier = false;

  /* ── Hall of Fame statues — a permanent (not event-driven) fixture
     near the 'fame' landmark. Rebuilt whenever GamePage pushes fresh
     top-3 leaderboard data via setHallOfFameStatues(); empty until the
     first push arrives shortly after the scene is ready. ── */
  private hallOfFameStatues: {
    rank: number;
    name: string;
    rep: number;
    isPlayer: boolean;
    wx: number;
    wy: number;
    glow: Phaser.GameObjects.Graphics;
    body: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  }[] = [];
  private nearStatueRank: number | null = null;

  /* ── Crowd reaction — a second, larger wave of citizens pulled toward
     a major-event moment (Town Crier announcing, Whale Alert/Treasure
     Hunt/Fireworks/Dance Festival going Live). Deliberately separate
     from eventGatherSnapshot (the existing small "inner circle" gather)
     so the two never fight over the same citizen's home/wanderRadius —
     triggerCrowdReaction() always samples from NPCs NOT already in
     eventGatherSnapshot. ── */
  private crowdReactionSnapshot: { npc: NpcData; homeX: number; homeY: number; wanderRadius: number }[] | null = null;


  /* ── Ready callback — called after NPCs are fully spawned so the loading
     screen stays visible until the city is populated and the first frame
     is guaranteed to be smooth. Set by RugTownGame before Phaser boots. ── */
  private onReadyCallback: ((scene: WorldScene) => void) | null = null;

  constructor() { super({ key: 'WorldScene' }); }

  /** Set by RugTownGame before game creation — called once all NPCs have
   *  been spawned and the scene is truly ready for the player to enter. */
  setOnReadyCallback(fn: (scene: WorldScene) => void) {
    this.onReadyCallback = fn;
  }

  /* ═══════════════════════════════════════════════════════════
     PRELOAD — Phase 9C: final master terrain only. Standalone landmark
     PNGs and the modular prop/filler library are NOT queued for the live
     city (already baked into the master).
     ═══════════════════════════════════════════════════════════ */
  preload() {
    WorldTerrainLayer.preloadScene(this);
    queueWorldCharacterLoads(this);
  }

  /* ═══════════════════════════════════════════════════════════
     CREATE
     ═══════════════════════════════════════════════════════════ */
  create() {
    charPerfMark('WorldScene.characterRegistryHydrate.start');
    hydrateCharacterRegistryFromScene(this);
    charPerfMark('WorldScene.characterRegistryHydrate.end');
    charPerfMeasure(
      'WorldScene.characterRegistryHydrate',
      'WorldScene.characterRegistryHydrate.start',
      'WorldScene.characterRegistryHydrate.end',
    );
    this.worldW = DEFAULT_WORLD_W;
    this.worldH = DEFAULT_WORLD_H;

    /* Plaza origin — needed by event positioning throughout the session */
    this.plazaX = this.worldW * SPAWN_FX;
    this.plazaY = this.worldH * SPAWN_FY;

    /* Dev QA: F8 opens Asset Gallery (Phase 7A) — not permanent gameplay UI */
    this.input.keyboard?.on('keydown-F8', () => {
      if (this.scene.isActive('AssetGalleryScene')) return;
      this.scene.sleep();
      this.scene.launch('AssetGalleryScene');
    });

    /* Dev QA: F9 toggles final-master geometry overlay (Phase 10A.1) */
    this.input.keyboard?.on('keydown-F9', () => {
      if (!this.collision) return;
      if (!this.architectureOverlay) {
        this.architectureOverlay = new NewWorldDebugOverlay(this);
      }
      this.architectureOverlay.setCollisionSystem(this.collision);
      this.architectureOverlay.setDoorZones(
        this.enterableDoors.map((d) => ({
          id: d.building.id,
          wx: d.wx,
          wy: d.wy,
          radius: d.radius,
        })),
      );
      this.architectureOverlay.setInteractZones(
        getLiveWorldObjects().map((o) => {
          const { wx, wy } = toWorldPosition(o, this.worldW, this.worldH);
          return { id: o.id, wx, wy, radius: o.interactionRadius };
        }),
      );
      this.architectureOverlay.setNpcFeet(this.npcs.map((n) => ({ x: n.px, y: n.py })));
      this.architectureOverlay.toggle(this.worldW, this.worldH, this.px, this.py, this.testBuildingSprites);
    });

    /* ── Spawn player: restored session position, else Spring Water ── */
    const defaultSpawn = spawnPointForSlot(0);
    const restored = this.pendingSpawn;
    if (
      restored
      && Number.isFinite(restored.x)
      && Number.isFinite(restored.y)
      && restored.x > 40
      && restored.y > 40
      && restored.x < this.worldW - 40
      && restored.y < this.worldH - 40
    ) {
      this.px = restored.x;
      this.py = restored.y;
    } else {
      this.px = defaultSpawn.x;
      this.py = defaultSpawn.y;
    }
    this.pendingSpawn = null;

    /* ── Create player layers (glow + bitmap body + label) ── */
    this.playerGlow  = this.add.graphics().setDepth(8);
    this.playerLabel = this.add.text(0, 0, 'You', {
      fontFamily: NAMEPLATE_FONT,
      fontSize:   '12px',
      fontStyle:  'bold',
      color:      '#ffe88a',
      backgroundColor: 'rgba(4,8,12,0.94)',
      padding: { x: 5, y: 2 },
      stroke: '#000000',
      strokeThickness: 4,
      resolution: WORLD_TEXT_RESOLUTION,
    }).setOrigin(0.5, 1).setDepth(11);

    this.playerSpeech = this.add.text(0, 0, '', {
      fontFamily: NAMEPLATE_FONT,
      fontSize:   '12px',
      color:      '#e8d8c0',
      backgroundColor: 'rgba(10,14,18,0.94)',
      padding: { x: 7, y: 4 },
      stroke: '#000000',
      strokeThickness: 3,
      align: 'center',
      resolution: WORLD_TEXT_RESOLUTION,
    }).setOrigin(0.5, 1).setDepth(12).setVisible(false);

    // Container for character transform (camera no longer startFollows this)
    this.player = this.add.container(this.px, this.py).setDepth(10);

    this.bitmapPlayer = new BitmapCharacter(this, this.appearance, {
      depth: 10,
      visualScale: PLAYER_VISUAL_SCALE,
    });
    this.bitmapPlayer.setPosition(this.px, this.py);
    this.bitmapPlayer.setFacing(this.facing);

    /* ── Phase 10B camera — exclusive owner of scroll/zoom ── */
    this.worldCamera = new WorldCameraController(this);
    this.worldCamera.attach(this.worldW, this.worldH, this.currentZoom);
    this.worldCamera.snapFollowToPlayer(this.px, this.py);
    this.worldCamera.canStartPan = (pointer) => !this.hitRemotePlayerAt(pointer);

    /* ── Input ── */
    this.setupInput();

    /* ── Remote player click-to-profile ──────────────────────────────
       pointer.worldX/Y accounts for camera scroll + zoom, so the hit
       test works at any zoom level. Uses a generous radius (CHAR_H * 0.65)
       so small pixel-art figures are tappable on mobile too. ── */
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const entry = this.remoteAtPointer(pointer);
      if (!entry) return;
      if (isPresenceStale(entry.lastSeenAt)) return;
      const now = this.time.now;
      if (now - this.lastSocialCardOpenAt < this.socialCardCooldownMs) return;
      this.lastSocialCardOpenAt = now;
      this.events.emit('remote-player-interact', presenceToSocialSummary({
        id:         entry.presenceId,
        username:   entry.username,
        x:          entry.px,
        y:          entry.py,
        appearance: entry.rawAppearance,
        rep:        entry.rep,
        holderTier: entry.holderTier,
        level:      entry.level,
        rankLabel:  entry.rankLabel,
        equippedTitle: entry.equippedTitle,
      }, {
        worldX: entry.px,
        worldY: entry.py,
        direction: entry.facing,
        lastSeenAt: entry.lastSeenAt,
        online: true,
      }));
    });

    /* ── Systems: collision + interaction (synchronous — need worldW/worldH) ── */
    this.collision = new CollisionSystem(this);
    // Phase 8J — walkable geometry now comes from NewCanonicalWorld.ts
    // (the "+"-shaped plaza+spoke approximation of the new background's
    // ring road), not the old RoadNetwork.ts default.
    this.collision.init(this.worldW, this.worldH, buildNewWalkableRects(this.worldW, this.worldH));
    this.interaction = new InteractionSystem(this);
    this.interaction.init(this.worldW, this.worldH);
    this.enterableDoors = buildEnterableDoorZones(this.worldW, this.worldH);
    this.landmarkCatalog = buildLandmarkCatalog(this.worldW, this.worldH);

    /* ── Weather graphics — must exist before update() runs ── */
    this.weatherGraphics = this.add.graphics().setDepth(40).setVisible(false);

    /* ── Event Engine — subscribe immediately so city events work from the
         first frame; scheduleNext() is lightweight (just starts a timer) ── */
    this.eventManagerUnsubscribe = this.eventManager.onChange((instance, prevPhase) => {
      this.handleEventPhaseChange(instance, prevPhase);
    });
    this.eventManager.scheduleNext();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.eventManagerUnsubscribe?.();
      this.eventManager.destroy();
      this.compactAmbience?.destroy();
      this.compactRoadRenderer?.destroy();
      this.worldCamera?.destroy();
      setActiveMissionBridge(null);
    });

    /* ── Initial draw ── */
    this.drawPlayer();

    /* ── Publish initial state — fires onReady in GamePage so HUD appears
         and the city is visible before citizens/ambience finish loading ── */
    this.registry.set('worldW',    this.worldW);
    this.registry.set('worldH',    this.worldH);
    this.registry.set('playerX',   this.px);
    this.registry.set('playerY',   this.py);
    this.registry.set('zoom',      this.currentZoom);
    this.registry.set('nearZone',  null);
    this.registry.set('nearDoor',  null);
    this.registry.set('nearNpc',   null);
    this.registry.set('nearTownCrier', false);
    this.registry.set('nearInteriorPrompt', null);
    this.registry.set('interiorState', { active: false, buildingId: null, displayName: null });

    /* ── Phase 5: rehydrate saved progress so completed missions stay
         completed and visited interiors persist across reloads. ── */
    const savedProgress = loadProgress();
    this.mission.restoreCompleted(savedProgress.completedMissions);
    this.visitedInteriors = new Set(savedProgress.visitedInteriors);
    this.missionBridge.subscribe((ev) => {
      if (this.mission.handleEvent(ev)) this.publishMissionState();
    });
    setActiveMissionBridge(this.missionBridge);
    this.registry.set('currentDistrict', '');
    this.publishMissionState();
    this.registry.set('collisionDebug', false);
    this.registry.set('assetBoundsDebug', false);
    this.registry.set('assetAnchorsDebug', false);
    this.registry.set('assetRoadDebug', false);
    this.registry.set('assetPlayerDepthDebug', false);

    /* ── Defer NPC citizens — short delay so the first frame renders before
         any expensive work starts, then spawn in batches of 5 at 20ms gaps.
         The ready callback fires AFTER the last batch so the loading screen
         remains visible until the city is fully populated — no GPU texture
         uploads mid-gameplay. ── */
    this.time.delayedCall(80, () => {
      charPerfMark('WorldScene.createNpcs.start');
      this.createNpcs();
      charPerfMark('WorldScene.createNpcs.end');
      charPerfMeasure(
        'WorldScene.createNpcs',
        'WorldScene.createNpcs.start',
        'WorldScene.createNpcs.end',
      );
    });

    /* ── Phase 9C: place final master terrain only ──
       Standalone landmark sprites and the old modular generators remain
       disconnected so they cannot duplicate buildings/roads/props already
       baked into RugTown_World_Master_Final_Upscaled.png. ── */
    this.time.delayedCall(80, () => {
      clearMinimapData();

      WorldTerrainLayer.generate(this, this.worldW, this.worldH);

      // Publish walkable + landmark geometry for the React minimap
      // (fractional coords relative to the final master dimensions).
      for (const r of buildNewWalkableRects(this.worldW, this.worldH)) {
        if (r.kind === 'road' || r.kind === 'plaza') {
          addMinimapRoad(r.x / this.worldW, r.y / this.worldH, r.w / this.worldW, r.h / this.worldH);
        }
      }
      for (const obj of WORLD_OBJECTS) {
        const s = 0.018;
        addMinimapBuilding(obj.x - s / 2, obj.y - s / 2, s, s);
      }

      this.registry.set('minimapWorld', getMinimapData());
    });

    const interior = this.scene.get('InteriorScene') as InteriorScene;
    interior.events.on('interior-exit', (payload: { buildingId: string | null }) => {
      if (payload.buildingId) this.exitInterior(payload.buildingId);
    });
    interior.events.on('interior-feature', (payload: { buildingId: string | null; label: string }) => {
      if (!payload.buildingId) return;
      if (payload.buildingId === 'hall-of-fame') {
        this.events.emit('interior-feature', {
          buildingId: payload.buildingId,
          title: 'Hall of Fame',
          text: 'Legacy plaques record the top citizens of RugTown. The monument remains active outside too.',
        });
      } else {
        this.events.emit('interior-feature', {
          buildingId: payload.buildingId,
          title: getEnterableBuilding(payload.buildingId)?.displayName ?? 'Interior',
          text: `${payload.label} hums with future mission hooks and city services.`,
        });
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     UPDATE — called every frame
     ═══════════════════════════════════════════════════════════ */
  update(_time: number, delta: number) {
    // Clamp to 100ms to prevent huge position jumps after tab-switch or
    // browser pause — without this a 1000ms delta moves the player 264px
    // in a single frame, which looks like teleporting.
    const clampedDelta = Math.min(delta, 100);
    const dt = clampedDelta / 1000;  // seconds
    this.lastDeltaMs = clampedDelta;
    this.tick += clampedDelta;
    this.animTick += clampedDelta;

    // NPC citizens redraw at 20fps to save GPU tessellation cost — they move
    // slowly enough that 20fps is imperceptible at play distance. The local
    // player and remote real players always draw every frame.
    this.charDrawAccum += clampedDelta;
    this.charDrawThisFrame = this.charDrawAccum >= CHAR_DRAW_INTERVAL;
    if (this.charDrawThisFrame) this.charDrawAccum = 0;

    /* ── Player blink timer — purely cosmetic, never touches movement ── */
    if (this.playerBlinkUntil > 0) {
      this.playerBlinkUntil -= delta;
    } else {
      this.playerBlinkTimerNext -= delta;
      if (this.playerBlinkTimerNext <= 0) {
        this.playerBlinkUntil = 120;
        this.playerBlinkTimerNext = Phaser.Math.Between(2000, 6000);
      }
    }

    /* ── Read input direction ── */
    const left  = this.keyA.isDown    || this.keyLeft.isDown;
    const right = this.keyD.isDown    || this.keyRight.isDown;
    const up    = this.keyW.isDown    || this.keyUp.isDown;
    const down  = this.keyS.isDown    || this.keyDown.isDown;

    let tvx = 0;
    let tvy = 0;
    if (left)  tvx -= PLAYER_SPEED;
    if (right) tvx += PLAYER_SPEED;
    if (up)    tvy -= PLAYER_SPEED;
    if (down)  tvy += PLAYER_SPEED;

    if (tvx !== 0 && tvy !== 0) {
      tvx *= PLAYER_DIAG;
      tvy *= PLAYER_DIAG;
    }

    /* ── Mobile virtual joystick — analog, only overrides when actually
       being touched (both axes 0 otherwise), so desktop keyboard input
       above is untouched when nothing on mobile is pressed. ── */
    if (this.virtualMoveX !== 0 || this.virtualMoveY !== 0) {
      tvx = this.virtualMoveX * PLAYER_SPEED;
      tvy = this.virtualMoveY * PLAYER_SPEED;
    }

    /* ── Instant start AND instant stop — fully deterministic, no curves.
       Acceleration/decel lerps felt inconsistent (slow start, lag, catch-up)
       especially combined with camera deadzone. Pure velocity assignment gives
       pixel-perfect, frame-rate-independent movement feel. ── */
    this.velX = tvx;
    this.velY = tvy;

    /* ── Phase 10B — WORLD_COLLISION_ENABLED gates solids.
       Movement: velocity × dt, optional resolveWalk (dormant when flag false),
       then world-edge clamp. Player must stay inside 4344×1448. ── */
    const resolved = this.collision.resolveWalk(this.px, this.py, this.velX, this.velY, dt);
    const margin = Math.max(FOOT_COLLIDER_W, FOOT_COLLIDER_H);
    const newX = Phaser.Math.Clamp(resolved.x, margin, this.worldW - margin);
    const newY = Phaser.Math.Clamp(resolved.y, margin, this.worldH - margin);

    const moved = Math.abs(newX - this.px) > 0.1 || Math.abs(newY - this.py) > 0.1;
    this.px = newX;
    this.py = newY;

    if (
      import.meta.env.DEV &&
      WORLD_COLLISION_ENABLED &&
      this.architectureOverlay?.isVisible() &&
      (Math.abs(this.velX) > 1 || Math.abs(this.velY) > 1)
    ) {
      console.debug(
        '[col]',
        `foot=(${Math.round(this.px)},${Math.round(this.py + FOOT_OFFSET_Y)})`,
        `prop=(${Math.round(this.collision.lastProposedX)},${Math.round(this.collision.lastProposedY)})`,
        `res=(${Math.round(newX)},${Math.round(newY)})`,
        `solids=${resolved.solidsChecked}`,
        `hit=${resolved.hitId ?? '-'}`,
        resolved.rejected ? 'REJECT' : resolved.hit ? 'SLIDE' : 'OK',
      );
    }

    /* ── Update facing direction ── */
    if (Math.abs(this.velX) > 10 || Math.abs(this.velY) > 10) {
      if (Math.abs(this.velX) >= Math.abs(this.velY)) {
        this.facing = this.velX > 0 ? 'right' : 'left';
      } else {
        this.facing = this.velY > 0 ? 'down' : 'up';
      }
    }
    this.isMoving = moved && (Math.abs(this.velX) > 8 || Math.abs(this.velY) > 8);

    /* ── Turn smoothing — subtle body lean into horizontal motion.
       Delta-corrected like the camera so the lean eases at a constant rate
       regardless of frame rate. ── */
    const leanTarget = Phaser.Math.Clamp(this.velX / PLAYER_SPEED, -1, 1) * LEAN_MAX;
    const leanFactor = LEAN_SMOOTH >= 1 ? 1 : 1 - Math.pow(1 - LEAN_SMOOTH, dt * 60);
    this.lean = Phaser.Math.Linear(this.lean, leanTarget, leanFactor);

    /* ── Move the container (camera follows this) ── */
    this.player.setPosition(this.px, this.py);

    if (this.architectureOverlay?.isVisible()) {
      const camDiag = this.worldCamera?.getDiagnostics();
      this.architectureOverlay.syncLive(
        this.px,
        this.py,
        this.npcs.map((n) => ({ x: n.px, y: n.py })),
        {
          cameraMode: camDiag?.mode ?? 'FOLLOWING',
          scrollX: camDiag?.scrollX ?? 0,
          scrollY: camDiag?.scrollY ?? 0,
          zoom: camDiag?.zoom ?? this.currentZoom,
          targetZoom: camDiag?.targetZoom ?? this.targetZoom,
          distToPlayer: camDiag?.distToPlayer ?? 0,
          worldCollisionEnabled: WORLD_COLLISION_ENABLED,
          playerSpeed: PLAYER_SPEED,
        },
      );
    }

    /* ── Phase 10B — WorldCameraController owns follow/pan/zoom ── */
    if (this.worldCamera && !this.interiorActive) {
      this.worldCamera.update(dt, this.px, this.py);
      this.currentZoom = this.worldCamera.getZoom();
      this.targetZoom = this.worldCamera.getTargetZoom();
    }

    /* ── Redraw player every frame ── */
    this.drawPlayer();

    /* ── NPC citizens ──
       All entity updates below use the SAME clamped delta as the player
       above. Passing raw delta here (while the player used clampedDelta)
       was what made citizens jump while the player crawled during a
       startup frame-drop — the "slow then explode" effect. ── */
    this.updateNpcs(clampedDelta);

    /* ── Remote real players (Realtime Presence) ── */
    this.updateRemotePlayers(clampedDelta);

    /* ── Nameplate collision pass (screen-space stack / cull) ── */
    this.layoutWorldNameplates();

    /* ── Event Engine weather overlay (purely cosmetic, additive layer) ── */
    this.updateWeatherEffect(clampedDelta);
    this.updateTreasureChest();
    this.updateWhaleMarker();
    this.updateTownCrier(clampedDelta);
    this.updateHallOfFameStatues();
    if (this.decorationGenerator) this.decorationGenerator.updateFountainGuide(clampedDelta, this.px, this.py, this.worldW, this.worldH);

    /* ── Landmark label visibility / mission pulse ── */
    if (this.buildingGenerator) {
      this.buildingGenerator.updateLabels(this.currentZoom, this.animTick, this.px, this.py, this.worldW, this.worldH);
      this.buildingGenerator.updateBuildingVisuals(this.px, this.py, this.worldW, this.worldH);
      this.buildingGenerator.getWorldAssetLoader()?.updatePlayerDepthDebug(this.px, this.py);
    }

    if (!this.interiorActive) {
      /* ── Phase 10D — single interaction target (doors/zones/NPCs/events) ── */
      this.updateInteractionsUnified();

      /* ── Phase 6 quick emotes (number keys 1–4) ── */
      this.updateQuickEmoteKeys();
    } else {
      if (this.nearDoorId !== null) {
        this.nearDoorId = null;
        this.registry.set('nearDoor', null);
      }
      if (this.nearTownCrier) {
        this.nearTownCrier = false;
        this.registry.set('nearTownCrier', false);
      }
      this.registry.set('activeInteractTarget', null);
      this.buildingGenerator?.setSelectedInteractTarget(null);
    }

    /* ── Reward feedback (floating text) ── */
    this.updateFloatingTexts(delta);

    /* ── Chat speech bubble countdown ── */
    if (this.playerSpeechUntil > 0) {
      this.playerSpeechUntil -= delta;
      if (this.playerSpeechUntil <= 0) {
        this.playerSpeech.setVisible(false);
      }
    }

    /* ── Emote pulse countdown ── */
    if (this.emotePulseUntil > 0) {
      this.emotePulseUntil -= delta;
      if (this.emotePulseUntil < 0) this.emotePulseUntil = 0;
    }

    /* ── Dynamic minimum zoom — keeps the city image covering the full
       viewport on any screen size/orientation. Re-clamping both values
       every frame (not just on new input) means a resize, rotation, or
       fullscreen toggle can never leave empty space showing, even if
       nothing zooms in response. ── */
    /* ── Zoom / recenter keys → WorldCameraController ── */
    if (this.worldCamera && !this.interiorActive) {
      if (Phaser.Input.Keyboard.JustDown(this.keyZoomIn)) {
        this.worldCamera.setTargetZoom(this.worldCamera.getTargetZoom() + ZOOM_STEP * 2);
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyZoomOut)) {
        this.worldCamera.setTargetZoom(this.worldCamera.getTargetZoom() - ZOOM_STEP * 2);
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyZoomReset)) {
        this.worldCamera.requestRecenter(true);
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyRecenter)) {
        this.worldCamera.requestRecenter(false);
      }
    }

    /* ── Publish state to React (throttled to every ~100ms) ── */
    if (this.tick > 100) {
      this.tick = 0;
      const camDiag = this.worldCamera?.getDiagnostics();
      this.registry.set('playerX', this.px);
      this.registry.set('playerY', this.py);
      this.registry.set('camX',    this.cameras.main.scrollX);
      this.registry.set('camY',    this.cameras.main.scrollY);
      this.registry.set('zoom',    this.currentZoom);
      this.registry.set('camMode', camDiag?.mode ?? 'FOLLOWING');
      this.registry.set('camNeedsRecenter', camDiag?.needsRecenterButton ?? false);
      this.registry.set('worldCollisionEnabled', WORLD_COLLISION_ENABLED);
      this.registry.set('playerSpeed', PLAYER_SPEED);
      this.publishMinimapLive();
      this.updateCurrentDistrict();
      this.updateLandmarkDiscovery(this.time.now);
    }
  }

  /** Phase 10C — live minimap marker snapshot for React map UI. */
  private publishMinimapLive(): void {
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;
    const viewW = cam.width / zoom;
    const viewH = cam.height / zoom;

    const events: MinimapEventMarker[] = [];
    if (this.treasureChest) {
      events.push({ kind: 'treasure', x: this.treasureChest.wx, y: this.treasureChest.wy, label: 'Treasure' });
    }
    if (this.whaleMarker) {
      events.push({ kind: 'whale', x: this.whaleMarker.wx, y: this.whaleMarker.wy, label: 'Whale Alert' });
    }
    if (this.townCrier) {
      events.push({ kind: 'town_crier', x: this.townCrier.wx, y: this.townCrier.wy, label: 'Town Crier' });
    }
    const currentEvent = this.registry.get('currentEvent') as { id?: string; phase?: string } | null;
    if (currentEvent?.id && currentEvent.phase === 'live') {
      events.push({ kind: 'event', x: this.plazaX, y: this.plazaY, label: currentEvent.id });
    }

    const snapshot: MinimapLiveSnapshot = {
      player: { x: this.px, y: this.py, facing: this.facing },
      npcs: this.npcs.map((n) => ({
        x: n.px,
        y: n.py,
        roaming: n.behaviorType === 'roamer',
      })),
      camera: {
        scrollX: cam.scrollX,
        scrollY: cam.scrollY,
        viewW,
        viewH,
      },
      events,
    };
    this.registry.set('minimapLive', snapshot);
    this.registry.set('playerFacing', this.facing);
  }

  /** Publish the district under the player (Phase 10A WORLD_DISTRICTS). */
  private updateCurrentDistrict() {
    const d = getDistrictAtWorld(this.px, this.py);
    const best = d?.name ?? WORLD_DISTRICTS[0]?.name ?? '';
    const id = d?.id ?? WORLD_DISTRICTS[0]?.id ?? null;
    if (best !== this.currentDistrictName) {
      this.currentDistrictName = best;
      this.registry.set('currentDistrict', best);
    }
    if (id && id !== this.currentDistrictId) {
      this.currentDistrictId = id;
      this.registry.set('currentDistrictId', id);
      this.events.emit('district-entered', { districtId: id, name: best });
    }
  }

  /** Phase 10F — first-visit landmark discovery (~10 Hz, enter hysteresis). */
  private updateLandmarkDiscovery(time: number): void {
    if (time - this.lastDiscoveryCheckAt < 100) return;
    this.lastDiscoveryCheckAt = time;
    const zones = this.interaction?.getZones?.() ?? [];
    for (const z of zones) {
      const dist = Phaser.Math.Distance.Between(this.px, this.py, z.wx, z.wy);
      const enterR = Math.max(36, (z.radius ?? 60) * 0.85);
      const exitR = enterR + 28;
      const armed = this.landmarkDiscoverArmed.has(z.id);
      if (!armed && dist <= enterR) {
        this.landmarkDiscoverArmed.add(z.id);
        this.events.emit('landmark-discovered', { landmarkId: z.id, name: z.name ?? z.id });
        if (this.mission.markZoneVisited(z.id)) this.publishMissionState();
      } else if (armed && dist > exitR) {
        this.landmarkDiscoverArmed.delete(z.id);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     DRAW PLAYER
     ═══════════════════════════════════════════════════════════ */
  private drawPlayer() {
    if (!this.bitmapPlayer) return;

    this.player.setPosition(this.px, this.py);
    this.bitmapPlayer.setPosition(this.px, this.py);
    this.bitmapPlayer.setFacing(this.facing);
    this.bitmapPlayer.update(this.lastDeltaMs, this.velX, this.velY, this.isMoving);

    /* ── Glow (gold pulse below feet) — player only, marks the main character. ── */
    this.playerGlow.clear();
    const glowT = (Math.sin(this.animTick / 600) + 1) / 2;
    const glowA = 0.08 + glowT * 0.08;
    for (const r of [26, 16, 7]) {
      this.playerGlow.fillStyle(0xe8b84b, glowA * (1 - r / 28));
      this.playerGlow.fillCircle(0, TARGET_DISPLAY_HEIGHT * 0.15, r * PLAYER_VISUAL_SCALE);
    }
    this.playerGlow.setPosition(this.px, this.py);

    const headYLocal = -TARGET_DISPLAY_HEIGHT * PLAYER_VISUAL_SCALE * 0.55;
    this.playerLabel.setPosition(Math.round(this.px), Math.round(this.py + headYLocal - 4));
    this.playerSpeech.setPosition(this.px, this.py + headYLocal - 14);
  }

  /* ═══════════════════════════════════════════════════════════
     Phase 9C — placeFiveTestBuildings disabled.
     The final master already includes baked buildings. Method retained
     as a no-op so any lingering references fail safely; do not re-enable
     without introducing duplicate overlaid landmark sprites.
     ═══════════════════════════════════════════════════════════ */
  private placeFiveTestBuildings(): void {
    this.testBuildingSprites = [];
    // Intentionally empty — FIVE_TEST_BUILDING_ASSETS kept for reference only.
    void FIVE_TEST_BUILDING_ASSETS;
  }

  /** Phase 8K Task 8 — picks a raw (pre-snap) candidate home point inside
   *  one of the 5 confirmed-walkable zones (central plaza, then N/E/S/W
   *  spokes in that order, matching CollisionSystem's rects), cycling by
   *  NPC index so population spreads across all 5 instead of clustering
   *  in one ring. Plaza candidates avoid the fountain's spawn-clearance
   *  radius; spoke candidates are a uniform point inside that corridor. */
  private npcHomeCandidateForZone(npcIndex: number): { x: number; y: number } {
    const rects = this.collision.getRects();
    const plazaRect = rects.find((r) => r.kind === 'plaza');
    const roadRects = rects.filter((r) => r.kind === 'road'); // [N, S, E, W]
    const zones = plazaRect ? [plazaRect, ...roadRects] : roadRects;
    if (zones.length === 0) return { x: NEW_FOUNTAIN_X, y: NEW_FOUNTAIN_Y };

    const zone = zones[npcIndex % zones.length];
    if (zone.kind === 'plaza') {
      const angle = Math.random() * Math.PI * 2;
      const maxRadius = Math.max(20, Math.min(zone.w, zone.h) / 2 - 30);
      const minRadius = Math.min(COMPACT_NPC_CONFIG.spawnClearanceRadius + 20, maxRadius);
      const radius = Phaser.Math.FloatBetween(minRadius, maxRadius);
      return {
        x: zone.x + zone.w / 2 + Math.cos(angle) * radius,
        y: zone.y + zone.h / 2 + Math.sin(angle) * radius,
      };
    }
    const pad = 14;
    return {
      x: Phaser.Math.FloatBetween(zone.x + pad, zone.x + Math.max(zone.w - pad, pad)),
      y: Phaser.Math.FloatBetween(zone.y + pad, zone.y + Math.max(zone.h - pad, pad)),
    };
  }

  /* ═══════════════════════════════════════════════════════════
     NPC CITIZENS
     Ambient population — not real players. Each NPC is anchored to
     a landmark and wanders within a radius of it (idle ⇄ walk ⇄
     pause), with per-NPC speed/timing so nothing is synchronized.
     ═══════════════════════════════════════════════════════════ */
  private createNpcs() {
    // Phase 8H — fixed population + district allocation. Per-NPC flavor
    // (personality-correlated name / appearance / timing) varies per session.
    // Population is CALIBRATION_NPC_COUNT (33 = 3× prior calibration).
    const population = Math.min(CALIBRATION_NPC_COUNT, COMPACT_NPC_CONFIG.totalPopulation);
    const usedNames = new Set<string>();
    const roster: { name: string; personality: NpcPersonality }[] = [];
    for (let i = 0; i < population; i++) {
      const personality = Phaser.Utils.Array.GetRandom(NPC_PERSONALITIES);
      roster.push({ name: pickNpcName(personality, usedNames), personality });
    }
    const names = roster.map((r) => r.name);
    const npcHomePositions: { x: number; y: number }[] = [];
    const NPC_MIN_SPACING = 72; // slightly tighter with denser crowds; still avoids stacking

    // Full landmark registry — still needed so roamers can look up ANY
    // district by name (adjacency-constrained, see updateNpcs), even
    // though initial homes are now assigned from NPC_HOME_LANDMARKS below.
    const landmarks = WORLD_OBJECTS.map(o => ({
      name: o.id,
      fx: o.x,
      fy: o.y,
      radius: Math.max(70, o.interactionRadius * 0.85),
    }));
    this.npcLandmarks = landmarks;

    // Publish the real roster up front so the HUD + chat simulator have the
    // right names/count immediately, even though the NPC objects below are
    // built in small batches across frames.
    this.registry.set('npcNames', names);
    this.registry.set('npcCount', names.length);

    const spawnNpc = (entry: { name: string; personality: NpcPersonality }, i: number) => {
      const { name, personality } = entry;
      const behaviorType = pickWeighted(NPC_BEHAVIOR_WEIGHTS).type;

      // Phase 8J Task 11 / Phase 8K Task 8 — NPCs no longer home to the
      // old WORLD_OBJECTS landmark fractions; that geometry belongs to
      // the previous compact-world visual layout, not the new
      // background. Instead they're distributed across the 5 confirmed-
      // walkable zones (central plaza + N/E/S/W spokes) so the plaza
      // doesn't get overcrowded, with a minimum-spacing check between
      // initial home points. homeLandmarkId/Index are kept as inert
      // placeholders (COMPACT_NPC_CONFIG.crossDistrictChance is 0 this
      // phase, so the old landmark-graph re-homing code never fires —
      // see updateNpcs()).
      const homeLandmarkId = 'fountain';
      const homeLandmarkIndex = 0;
      const npcHomeRadiusBase = 110;

      let homeX = NEW_FOUNTAIN_X, homeY = NEW_FOUNTAIN_Y;
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = this.npcHomeCandidateForZone(i);
        const snapped = this.snapToWalkable(candidate.x, candidate.y);
        const farEnough = npcHomePositions.every(
          (p) => Math.hypot(p.x - snapped.x, p.y - snapped.y) >= NPC_MIN_SPACING,
        );
        if (farEnough || attempt === 19) {
          homeX = snapped.x;
          homeY = snapped.y;
          break;
        }
      }
      npcHomePositions.push({ x: homeX, y: homeY });

      // Phase 11C Task 16 — real district lookup (was hardcoded 'spawn').
      // Computed once from the NPC's home, not re-evaluated every frame:
      // homes are fixed, and re-checking per-frame would risk visible
      // behavior flicker for NPCs wandering near a district boundary.
      const districtId = getDistrictAtWorld(homeX, homeY)?.id ?? 'spring_core';
      const speedMult = NPC_DISTRICT_SPEED_MULT[districtId] ?? 1;
      const pauseMult = NPC_DISTRICT_PAUSE_MULT[districtId] ?? 1;

      const spawnAngle = Math.random() * Math.PI * 2;
      const spawnDist  = Math.random() * npcHomeRadiusBase * 0.3;
      const spawn = this.snapToWalkable(
        homeX + Math.cos(spawnAngle) * spawnDist,
        homeY + Math.sin(spawnAngle) * spawnDist,
      );
      const px = spawn.x;
      const py = spawn.y;

      const bitmap = new BitmapCharacter(
        this,
        npcAppearanceFromId(`${name}${i}`, listNpcBodies()),
        { depth: 7, visualScale: NPC_SCALE, alpha: NPC_ALPHA },
      );
      bitmap.setPosition(px, py);

      // Just the short name by default — the honesty rule ("RugTown
      // Citizens, never real users") is still satisfied via the "·
      // Citizen" suffix shown up close (see updateNpcs()) and the
      // existing [NPC] tags in chat/dialogue, without cluttering every
      // citizen's head with text all the time (req. C).
      const label  = this.add.text(0, 0, ellipsizeName(name, 12), {
        fontFamily: NAMEPLATE_FONT,
        fontSize:   '11px',
        fontStyle:  'bold',
        color:      '#e8f0f8',
        backgroundColor: 'rgba(4,8,12,0.92)',
        padding: { x: 4, y: 2 },
        stroke: '#000000',
        strokeThickness: 4,
        resolution: WORLD_TEXT_RESOLUTION,
      }).setOrigin(0.5, 1).setDepth(7.2);

      const speech = this.add.text(0, 0, '', {
        fontFamily: NAMEPLATE_FONT,
        fontSize:   '12px',
        color:      '#e8d8c0',
        backgroundColor: 'rgba(10,14,18,0.94)',
        padding: { x: 6, y: 3 },
        stroke: '#000000',
        strokeThickness: 3,
        align: 'center',
        resolution: WORLD_TEXT_RESOLUTION,
      }).setOrigin(0.5, 1).setDepth(7.4).setVisible(false);

      // Idle-leaning citizens pause longer and wander less; gatherers stay
      // tighter to their landmark; roamers get a wider radius since they'll
      // also periodically re-home to a different landmark entirely.
      const pauseScale = behaviorType === 'idle' ? 1.8 : behaviorType === 'gatherer' ? 1.2 : 1;
      const radiusScale = behaviorType === 'gatherer' ? 0.55 : behaviorType === 'roamer' ? 1.6 : 1;

      this.npcs.push({
        name,
        px, py,
        velX: 0, velY: 0,
        facing: 'down',
        isMoving: false,
        speed: Phaser.Math.FloatBetween(NPC_SPEED_MIN, NPC_SPEED_MAX) * (behaviorType === 'idle' ? 0.8 : 1) * speedMult,
        homeX, homeY,
        wanderRadius: npcHomeRadiusBase * Phaser.Math.FloatBetween(0.7, 1.15) * radiusScale,
        targetX: px, targetY: py,
        state: 'idle',
        stateTimer: Phaser.Math.Between(200, 2000),          // stagger first decisions
        pauseMin: Phaser.Math.Between(900, 1800) * pauseScale * pauseMult,
        pauseMax: Phaser.Math.Between(2200, 4500) * pauseScale * pauseMult,
        walkMin: Phaser.Math.Between(900, 1600),
        walkMax: Phaser.Math.Between(1800, 3200),
        animTick: Phaser.Math.Between(0, 4000),               // random phase offset
        lean: 0,
        personality,
        behaviorType,
        homeLandmarkIndex,
        homeLandmarkId,
        districtId,
        speechTimerNext: Phaser.Math.Between(NPC_SPEECH_MIN_GAP, NPC_SPEECH_MAX_GAP),
        speechShowUntil: 0,
        speechOffsetX: Phaser.Math.Between(-7, 7),
        speechOffsetY: Phaser.Math.Between(-9, 0),
        labelNear: false,
        blinkTimerNext: Phaser.Math.Between(2000, 6000),
        blinkUntil: 0,
        lastFacingChangeMs: 0,
        pendingTargetX: px,
        pendingTargetY: py,
        bitmap, label, speech,
      });
    };

    // Staggered spawn keeps load smooth with denser crowds (~7 batches).
    const BATCH = 5;
    let idx = 0;
    const spawnBatch = () => {
      const end = Math.min(idx + BATCH, roster.length);
      for (let i = idx; i < end; i++) spawnNpc(roster[i], i);
      idx = end;
      if (idx < roster.length) {
        this.time.delayedCall(20, spawnBatch);
      } else {
        // All NPCs spawned — signal that the scene is truly ready.
        this.onReadyCallback?.(this);
      }
    };
    spawnBatch();
  }

  private updateNpcs(delta: number) {
    const dt = delta / 1000;

    // Camera-view culling bounds (with a margin so characters don't pop
    // in/out right at the screen edge). Computed once per frame, not
    // per-NPC, so scaling to 60 citizens stays cheap.
    const view = this.cameras.main.worldView;
    const cullMargin = 260;
    const viewLeft   = view.x - cullMargin;
    const viewRight  = view.x + view.width + cullMargin;
    const viewTop    = view.y - cullMargin;
    const viewBottom = view.y + view.height + cullMargin;

    this.npcChatCooldownRemaining = Math.max(0, this.npcChatCooldownRemaining - delta);

    for (const n of this.npcs) {
      n.animTick += delta;
      n.stateTimer -= delta;

      /* ── State machine: idle/pause → look → walk → idle/pause → ... ──
         Phase 11C added 'look' as a brief anticipation beat: NPCs now
         choose their next destination and turn to face it BEFORE they
         start moving, instead of snapping straight into a walk. ── */
      if (n.state === 'walk') {
        const dx = n.targetX - n.px;
        const dy = n.targetY - n.py;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < NPC_ARRIVE_DIST || n.stateTimer <= 0) {
          n.state = 'pause';
          n.stateTimer = Phaser.Math.Between(n.pauseMin, n.pauseMax);
          // Ambience — face a nearby citizen, a random direction, or stay put
          if (Math.random() < NPC_FACE_CHANCE) {
            if (Math.random() < 0.55) this.faceNearbyNpc(n);
            else this.faceRandomDirection(n);
          } else if (Math.random() < 0.4) {
            this.faceRandomDirection(n);
          }
          n.lastFacingChangeMs = n.animTick;

          // Roamers occasionally adopt a road-ADJACENT landmark as their new
          // home (Task 8: cross-district movement follows connected roads,
          // stays mostly local — COMPACT_NPC_CONFIG.crossDistrictChance).
          if (n.behaviorType === 'roamer' && Math.random() < COMPACT_NPC_CONFIG.crossDistrictChance) {
            const neighborIds = ROAD_ADJACENCY[n.homeLandmarkId] ?? [];
            if (neighborIds.length > 0) {
              const nextId = Phaser.Utils.Array.GetRandom(neighborIds);
              const idx = this.npcLandmarks.findIndex(l => l.name === nextId);
              if (idx >= 0) {
                const lm = this.npcLandmarks[idx];
                n.homeLandmarkIndex = idx;
                n.homeLandmarkId = nextId;
                n.districtId = getDistrictForLandmark(lm.name);
                const snapped = this.snapToWalkable(
                  this.worldW * lm.fx + Phaser.Math.Between(-20, 20),
                  this.worldH * lm.fy + Phaser.Math.Between(-20, 20),
                );
                n.homeX = snapped.x;
                n.homeY = snapped.y;
                n.wanderRadius = lm.radius * Phaser.Math.FloatBetween(0.7, 1.15) * 1.6;
              }
            }
          }
        } else {
          const accel = Math.min(dt / NPC_ACCEL_TIME, 1);
          let targetVX = (dx / dist) * n.speed;
          let targetVY = (dy / dist) * n.speed;
          const sep = this.npcSeparationNudge(n);
          targetVX += sep.x;
          targetVY += sep.y;
          n.velX = Phaser.Math.Linear(n.velX, targetVX, accel);
          n.velY = Phaser.Math.Linear(n.velY, targetVY, accel);
        }
      } else if (n.state === 'look') {
        const accel = Math.min(dt / NPC_ACCEL_TIME, 1);
        n.velX = Phaser.Math.Linear(n.velX, 0, accel);
        n.velY = Phaser.Math.Linear(n.velY, 0, accel);
        if (n.stateTimer <= 0) {
          n.targetX = n.pendingTargetX;
          n.targetY = n.pendingTargetY;
          n.state = 'walk';
          n.stateTimer = Phaser.Math.Between(n.walkMin, n.walkMax);
        }
      } else {
        // idle | pause
        const accel = Math.min(dt / NPC_ACCEL_TIME, 1);
        n.velX = Phaser.Math.Linear(n.velX, 0, accel);
        n.velY = Phaser.Math.Linear(n.velY, 0, accel);

        if (n.stateTimer <= 0) {
          // Pick a new wander target near home that lands ON the road network,
          // so citizens respect roads exactly like the player. Retry a few
          // random offsets; fall back to home (always a walkable plaza).
          // Task 6/12/13/15 — also reject spawn-clearance, door-clearance,
          // bridge-over-capacity, and other-NPC-target pileups.
          let tx = n.homeX, ty = n.homeY;
          for (let attempt = 0; attempt < 8; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.random() * n.wanderRadius;
            const cx = Phaser.Math.Clamp(n.homeX + Math.cos(angle) * dist, CHAR_W, this.worldW - CHAR_W);
            const cy = Phaser.Math.Clamp(n.homeY + Math.sin(angle) * dist, CHAR_H, this.worldH - CHAR_H);
            if (this.isWalkable(cx, cy) && this.isGoodNpcTarget(cx, cy, n)) { tx = cx; ty = cy; break; }
          }
          // Phase 11C Task 14 — "look before you walk": queue the target,
          // turn to face it now, and hold briefly in 'look' before the
          // walk actually starts (see the 'look' branch above).
          n.pendingTargetX = tx;
          n.pendingTargetY = ty;
          const ldx = tx - n.px, ldy = ty - n.py;
          if (Math.abs(ldx) > 2 || Math.abs(ldy) > 2) {
            n.facing = Math.abs(ldx) >= Math.abs(ldy) ? (ldx > 0 ? 'right' : 'left') : (ldy > 0 ? 'down' : 'up');
            n.lastFacingChangeMs = n.animTick;
          }
          n.state = 'look';
          n.stateTimer = NPC_LOOK_AROUND_MS;
        }
      }

      /* ── Apply movement — road-only with axis sliding (same rules as the
         player). Skip resolveWalk entirely when the NPC is nearly stopped —
         it would move <0.02px and the collision check adds needless CPU. ── */
      let moved = false;
      if (Math.abs(n.velX) > 0.5 || Math.abs(n.velY) > 0.5) {
        const resolved = this.resolveWalk(n.px, n.py, n.velX, n.velY, dt);
        const newX = Phaser.Math.Clamp(resolved.x, CHAR_W / 2, this.worldW - CHAR_W / 2);
        const newY = Phaser.Math.Clamp(resolved.y, CHAR_H / 2, this.worldH - CHAR_H / 2);
        moved = Math.abs(newX - n.px) > 0.1 || Math.abs(newY - n.py) > 0.1;
        if (!moved && n.state === 'walk' && (Math.abs(n.velX) > 4 || Math.abs(n.velY) > 4)) {
          n.stateTimer = 0; // blocked against road edge → choose a new target
        }
        n.px = newX;
        n.py = newY;
      } else {
        n.velX = 0;
        n.velY = 0;
      }

      // Phase 11C — hysteresis: only let velocity re-decide facing after
      // NPC_FACING_MIN_INTERVAL_MS has passed since the last change. Near
      // a 45° heading, velX/velY can trade dominance frame to frame while
      // accelerating, which snapped facing back and forth ("instant
      // repeated 90-degree turns" per Task 14).
      if (
        (Math.abs(n.velX) > 6 || Math.abs(n.velY) > 6) &&
        n.animTick - n.lastFacingChangeMs >= NPC_FACING_MIN_INTERVAL_MS
      ) {
        const next: Direction = Math.abs(n.velX) >= Math.abs(n.velY)
          ? (n.velX > 0 ? 'right' : 'left')
          : (n.velY > 0 ? 'down' : 'up');
        if (next !== n.facing) {
          n.facing = next;
          n.lastFacingChangeMs = n.animTick;
        }
      }
      n.isMoving = moved && (Math.abs(n.velX) > 4 || Math.abs(n.velY) > 4);

      const leanTarget = Phaser.Math.Clamp(n.velX / n.speed, -1, 1) * NPC_LEAN_MAX;
      n.lean = Phaser.Math.Linear(n.lean, leanTarget, NPC_LEAN_SMOOTH);

      /* ── Viewport culling — citizens far outside the camera view skip
         redraw + go invisible. Cheap with 10 NPCs, necessary at 40-60. ── */
      const onScreen = n.px >= viewLeft && n.px <= viewRight && n.py >= viewTop && n.py <= viewBottom;
      if (!onScreen) {
        if (n.bitmap.root.visible) {
          n.bitmap.setVisible(false);
          n.label.setVisible(false);
          n.speech.setVisible(false);
        }
        continue;
      }
      if (!n.bitmap.root.visible) {
        n.bitmap.setVisible(true);
        n.label.setVisible(true);
      }

      /* ── Speech bubbles — occasional, desynchronized per NPC, capped at
         NPC_SPEECH_MAX_VISIBLE simultaneous bubbles city-wide so crowds
         and event moments can't paper the screen in text. Forwarding
         into the city chat panel is separately rate-limited by a single
         GLOBAL cooldown so 60 citizens don't spam 6x harder than 10
         used to. ── */
      if (n.speechShowUntil > 0) {
        n.speechShowUntil -= delta;
        if (n.speechShowUntil <= 0) {
          n.speech.setVisible(false);
        }
      } else {
        n.speechTimerNext -= delta;
        if (n.speechTimerNext <= 0) {
          n.speechTimerNext = Phaser.Math.Between(NPC_SPEECH_MIN_GAP, NPC_SPEECH_MAX_GAP);
          if (Math.random() < NPC_SPEECH_CHANCE && this.countVisibleNpcSpeechBubbles() < NPC_SPEECH_MAX_VISIBLE) {
            const line = Math.random() < 0.38
              ? getRandomDistrictLine(n.districtId)
              : Phaser.Utils.Array.GetRandom(NPC_SPEECH_BY_PERSONALITY[n.personality]);
            n.speech.setText(line);
            n.speech.setVisible(true);
            n.speechShowUntil = NPC_SPEECH_DURATION;
            if (this.npcChatCooldownRemaining <= 0) {
              this.npcChatCooldownRemaining = NPC_CHAT_GLOBAL_COOLDOWN;
              this.events.emit('npc-chat', { name: n.name, text: line });
            }
          }
        }
      }

      /* ── Name label — Phase 8K Task 9: hidden beyond
         NPC_LABEL_VISIBLE_RADIUS of the player so a crowded plaza
         doesn't turn into a wall of overlapping nameplates. Speech
         bubble hides when not speaking (handled below). ── */
      const labelDist = Math.hypot(n.px - this.px, n.py - this.py);
      n.label.setVisible(labelDist <= NPC_LABEL_VISIBLE_RADIUS);

      /* ── Blink timer — purely cosmetic, no movement/state impact ── */
      if (n.blinkUntil > 0) {
        n.blinkUntil -= delta;
      } else {
        n.blinkTimerNext -= delta;
        if (n.blinkTimerNext <= 0) {
          n.blinkUntil = 120;
          n.blinkTimerNext = Phaser.Math.Between(2000, 6000);
        }
      }

      if (this.charDrawThisFrame) this.drawNpc(n, delta);
    }
  }

  private drawNpc(n: NpcData, delta: number) {
    n.bitmap.setPosition(n.px, n.py);
    n.bitmap.setFacing(n.facing);
    n.bitmap.update(delta, n.velX, n.velY, n.isMoving);

    const headYLocal = -TARGET_DISPLAY_HEIGHT * NPC_SCALE * 0.55;
    const labelY = n.py + headYLocal - 3;
    n.label.setPosition(Math.round(n.px), Math.round(labelY));
    // Keep speech above the nameplate so bubbles don't sit on names.
    const speechLift = n.speech.visible ? 22 : 10;
    n.speech.setPosition(n.px + n.speechOffsetX, labelY - speechLift + n.speechOffsetY);
  }

  /**
   * Screen-space nameplate layout — local > remote > NPC priority,
   * vertical stacking when anchors collide, cull when crowded/off-camera.
   */
  private layoutWorldNameplates() {
    const cam = this.cameras.main;
    if (!cam || !this.playerLabel) return;

    const slots: NameplateSlot[] = [];
    const headLocal = -TARGET_DISPLAY_HEIGHT * PLAYER_VISUAL_SCALE * 0.55;
    slots.push({
      id: 'local',
      priority: 'local',
      worldX: this.px,
      worldY: this.py + headLocal - 4,
      text: this.playerLabel,
      forceVisible: true,
    });

    this.remotePlayerEntries.forEach((entry, id) => {
      if (!entry.label?.visible && !entry.label) return;
      const head = -TARGET_DISPLAY_HEIGHT * REMOTE_PLAYER_VISUAL_SCALE * 0.55;
      slots.push({
        id: `remote:${id}`,
        priority: 'remote',
        worldX: entry.px,
        worldY: entry.py + head - 4,
        text: entry.label,
      });
    });

    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      if (!n.label.visible) continue;
      const head = -TARGET_DISPLAY_HEIGHT * NPC_SCALE * 0.55;
      slots.push({
        id: `npc:${i}`,
        priority: 'npc',
        worldX: n.px,
        worldY: n.py + head - 3,
        text: n.label,
      });
    }

    layoutNameplates(cam, slots, {
      minGapPx: cam.width < 500 ? 13 : 15,
      maxSecondary: cam.width < 500 ? 5 : 10,
    });
  }

  /**
   * Ambience only — turns `n` to face a random cardinal direction while paused.
   */
  private faceRandomDirection(n: NpcData) {
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];
    n.facing = Phaser.Utils.Array.GetRandom(dirs);
  }

  /**
   * Phase 11C Task 17 — lightweight personal-space steering. Returns a
   * small extra velocity nudge (px/s) away from any other walking NPC
   * within NPC_PERSONAL_SPACE_RADIUS, so citizens visibly bunching
   * together get gently pushed apart instead of overlapping. This is a
   * per-frame nudge on top of the normal seek-target velocity, not a
   * physics/crowd simulation — O(n) over the current small population.
   */
  private npcSeparationNudge(n: NpcData): { x: number; y: number } {
    let x = 0, y = 0;
    for (const other of this.npcs) {
      if (other === n) continue;
      const dx = n.px - other.px;
      const dy = n.py - other.py;
      const distSq = dx * dx + dy * dy;
      if (distSq >= NPC_PERSONAL_SPACE_RADIUS * NPC_PERSONAL_SPACE_RADIUS || distSq < 0.01) continue;
      const dist = Math.sqrt(distSq);
      const push = (1 - dist / NPC_PERSONAL_SPACE_RADIUS) * NPC_SEPARATION_PUSH;
      x += (dx / dist) * push;
      y += (dy / dist) * push;
    }
    return { x, y };
  }

  /**
   * Ambience only — turns `n` to face the nearest other NPC within
   * NPC_FACE_RADIUS, if any. Doesn't move anyone or change timing.
   * Phase 8H (Task 13): skipped on the bridge — no conversation pairs on
   * the narrow crossing.
   */
  private faceNearbyNpc(n: NpcData) {
    const bridge = getWorldObject('bridge');
    if (bridge) {
      const bx = bridge.x * this.worldW, by = bridge.y * this.worldH;
      if (Math.hypot(n.px - bx, n.py - by) < bridge.interactionRadius) return;
    }

    let nearest: NpcData | null = null;
    let nearestDist = NPC_FACE_RADIUS;

    for (const other of this.npcs) {
      if (other === n) continue;
      const dx = other.px - n.px;
      const dy = other.py - n.py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearest = other;
        nearestDist = dist;
      }
    }

    if (!nearest) return;

    const dx = nearest.px - n.px;
    const dy = nearest.py - n.py;
    if (Math.abs(dx) >= Math.abs(dy)) {
      n.facing = dx > 0 ? 'right' : 'left';
    } else {
      n.facing = dy > 0 ? 'down' : 'up';
    }
  }

  /**
   * True once for an E key press OR a mobile interact-button tap —
   * whichever happened. The virtual flag is consumed (reset) on read so
   * a single tap can't fire twice across the same frame's two proximity
   * checks (zone vs NPC), matching how Keyboard.JustDown already behaves.
   */
  private consumeInteractPress(): boolean {
    if (Phaser.Input.Keyboard.JustDown(this.keyE)) return true;
    if (this.virtualInteractRequested) {
      this.virtualInteractRequested = false;
      return true;
    }
    return false;
  }

  /**
   * Phase 10D — gather candidates, pick one deterministic target, sync HUD,
   * then execute on E / mobile interact. Interaction uses player world
   * position (not camera).
   */
  private updateInteractionsUnified(): void {
    const missionZoneId = this.mission.getHighlightedZoneId();
    const currentEvent = this.registry.get('currentEvent') as { landmarkId?: string; phase?: string } | null;
    const eventIds: string[] = [];
    if (currentEvent?.landmarkId && (currentEvent.phase === 'live' || currentEvent.phase === 'announcement')) {
      eventIds.push(currentEvent.landmarkId);
    }
    this.buildingGenerator?.setEventLandmarkIds(eventIds);

    const candidates: InteractCandidate[] = [];

    for (const door of this.enterableDoors) {
      const meta = this.landmarkCatalog.find((l) => l.interiorId === door.building.id);
      const isMission = missionZoneId === door.building.worldObjectId;
      candidates.push({
        kind: 'door',
        id: door.building.id,
        name: door.building.displayName,
        x: door.wx,
        y: door.wy,
        radius: door.radius,
        priorityBand: isMission ? PRIORITY.MISSION_DOOR : PRIORITY.DOOR,
        missionBoost: isMission,
        access: door.building.access,
        action: door.building.access === 'open' ? 'enter'
          : door.building.access === 'coming_soon' ? 'coming_soon' : 'locked',
        actionLabel: door.building.access === 'open' ? `Enter ${door.building.displayName}`
          : door.building.access === 'coming_soon' ? 'Coming Soon' : 'Locked',
        lockedReason: door.building.lockedMessage,
        status: door.building.access === 'open' ? 'available'
          : door.building.access === 'coming_soon' ? 'coming_soon' : 'locked',
        mobileLabel: door.building.access === 'open' ? 'Enter' : door.building.access === 'coming_soon' ? 'Soon' : 'Locked',
      });
      if (meta) {
        // Prefer door over zone for same building — skip zone duplicate via band
      }
    }

    for (const z of this.interaction.getZones()) {
      // Skip live zones that have an enterable door (door owns the interact)
      if (this.enterableDoors.some((d) => d.building.worldObjectId === z.id)) continue;
      const meta = this.landmarkCatalog.find((l) => l.id === z.id);
      const isMission = missionZoneId === z.id;
      candidates.push({
        kind: 'zone',
        id: z.id,
        name: z.name,
        x: z.wx,
        y: z.wy,
        radius: z.radius,
        priorityBand: isMission ? PRIORITY.MISSION_ZONE : PRIORITY.ZONE,
        missionBoost: isMission,
        action: meta?.action ?? 'inspect',
        actionLabel: meta?.actionLabel ?? 'Inspect',
        status: isMission ? 'mission' : (meta?.status ?? 'available'),
        lockedReason: meta?.lockedReason,
        mobileLabel: meta?.action === 'gather' ? 'Gather'
          : meta?.action === 'read' ? 'Read'
          : meta?.action === 'open_market' ? 'Market'
          : 'Inspect',
      });
    }

    for (const n of this.npcs) {
      candidates.push({
        kind: 'npc',
        id: `npc:${n.name}`,
        name: n.name,
        x: n.px,
        y: n.py,
        radius: NPC_TALK_RADIUS,
        priorityBand: PRIORITY.NPC,
        action: 'talk',
        actionLabel: 'Talk',
        mobileLabel: 'Talk',
      });
    }

    if (this.treasureChest) {
      candidates.push({
        kind: 'treasure',
        id: 'treasure',
        name: 'Treasure Chest',
        x: this.treasureChest.wx,
        y: this.treasureChest.wy,
        radius: TREASURE_INTERACT_RADIUS,
        priorityBand: PRIORITY.TREASURE,
        mobileLabel: 'Open',
      });
    }
    if (this.whaleMarker) {
      candidates.push({
        kind: 'whale',
        id: 'whale-alert',
        name: 'Whale Alert',
        x: this.whaleMarker.wx,
        y: this.whaleMarker.wy,
        radius: WHALE_INTERACT_RADIUS,
        priorityBand: PRIORITY.WHALE,
        mobileLabel: 'Inspect',
      });
    }
    if (this.townCrier) {
      candidates.push({
        kind: 'town_crier',
        id: 'town-crier',
        name: 'Town Crier',
        x: this.townCrier.wx,
        y: this.townCrier.wy,
        radius: 86,
        priorityBand: PRIORITY.TOWN_CRIER,
        action: 'talk',
        mobileLabel: 'Talk',
      });
    }
    for (const s of this.hallOfFameStatues) {
      candidates.push({
        kind: 'statue',
        id: `statue:${s.rank}`,
        name: s.name,
        x: s.wx,
        y: s.wy,
        radius: STATUE_INTERACT_RADIUS,
        priorityBand: PRIORITY.STATUE,
        mobileLabel: 'Inspect',
      });
    }

    // Phase 10E — nearby real players (exclude local, reject stale)
    const nowMs = Date.now();
    const face = this.facing;
    const faceVec =
      face === 'up' ? { x: 0, y: -1 } :
      face === 'down' ? { x: 0, y: 1 } :
      face === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };

    let nearbyPlayerCount = 0;
    this.remotePlayerEntries.forEach((entry) => {
      if (isPresenceStale(entry.lastSeenAt, nowMs)) return;
      const dx = entry.px - this.px;
      const dy = entry.py - this.py;
      const dist = Math.hypot(dx, dy);
      if (dist > PLAYER_INTERACT_RADIUS) return;
      nearbyPlayerCount++;
      const len = dist || 1;
      const facingScore = (dx / len) * faceVec.x + (dy / len) * faceVec.y;
      const facingBoost = facingScore >= PLAYER_FACING_CONE;
      candidates.push({
        kind: 'player',
        id: entry.presenceId,
        name: entry.username,
        x: entry.px,
        y: entry.py,
        radius: PLAYER_INTERACT_RADIUS,
        priorityBand: facingBoost ? PRIORITY.PLAYER_FACING : PRIORITY.PLAYER,
        mobileLabel: 'View',
      });
    });

    const resolved = resolveInteractTarget(
      { x: this.px, y: this.py, facing: this.facing },
      candidates,
      {
        previousId: this.stickyInteractId,
        heldSince: this.stickyInteractSince,
        now: this.time.now,
      },
    );
    const target = resolved.target;

    if (target) {
      if (target.id !== this.stickyInteractId) {
        this.stickyInteractId = target.id;
        this.stickyInteractSince = this.time.now;
      }
    } else {
      this.stickyInteractId = null;
      this.stickyInteractSince = 0;
    }

    // Sync legacy near-* registry so existing GamePage listeners keep working
    this.syncNearFlagsFromTarget(target);

    const prompt = target
      ? formatInteractPrompt(target, { fountainUnclaimed: undefined })
      : null;

    this.registry.set('activeInteractTarget', target ? {
      kind: target.kind,
      id: target.id,
      name: target.name,
      access: target.access ?? null,
      action: target.action ?? null,
      actionLabel: target.actionLabel ?? null,
      mobileLabel: target.mobileLabel ?? prompt?.mobile ?? 'Interact',
      desktopPrompt: prompt?.desktop ?? '',
      status: target.status ?? null,
      lockedReason: target.lockedReason ?? null,
      distance: resolved.distance,
      facingScore: resolved.facingScore,
      priorityScore: resolved.priorityScore,
      hysteresisHeld: resolved.hysteresisHeld,
    } : null);

    // Landmark label highlight
    const labelId =
      target?.kind === 'door'
        ? (this.enterableDoors.find((d) => d.building.id === target.id)?.building.worldObjectId ?? null)
        : target?.kind === 'zone'
          ? target.id
          : null;
    this.buildingGenerator?.setSelectedInteractTarget(labelId);

    // Remote player selection highlight
    const nextRemoteId = target?.kind === 'player' ? target.id : null;
    if (nextRemoteId !== this.selectedRemotePlayerId) {
      if (this.selectedRemotePlayerId) {
        const prev = this.remotePlayerEntries.get(this.selectedRemotePlayerId);
        if (prev) prev.selected = false;
      }
      this.selectedRemotePlayerId = nextRemoteId;
      if (nextRemoteId) {
        const cur = this.remotePlayerEntries.get(nextRemoteId);
        if (cur) cur.selected = true;
      }
    }

    // Interaction debug for F9
    const selectedEntry = nextRemoteId ? this.remotePlayerEntries.get(nextRemoteId) : null;
    this.registry.set('interactDebug', {
      targetId: target?.id ?? null,
      targetKind: target?.kind ?? null,
      distance: resolved.distance,
      facingScore: resolved.facingScore,
      priorityScore: resolved.priorityScore,
      hysteresisHeld: resolved.hysteresisHeld,
      nearbyPlayerCount,
      selectedPlayerId: nextRemoteId,
      selectedPlayerName: selectedEntry?.username ?? null,
      selectedPlayerStaleAge: selectedEntry ? nowMs - selectedEntry.lastSeenAt : null,
      selectedPlayerX: selectedEntry?.px ?? null,
      selectedPlayerY: selectedEntry?.py ?? null,
      socialCardOpen: !!this.registry.get('socialCardOpen'),
      dmRecipientId: (this.registry.get('dmRecipient') as { playerId?: string } | null)?.playerId ?? null,
      candidateCount: candidates.filter((c) => {
        const d = Math.hypot(c.x - this.px, c.y - this.py);
        return d <= c.radius;
      }).length,
      labels: this.buildingGenerator?.getLabelSystem()?.getLastDebug() ?? [],
    });

    if (!target) return;
    if (this.registry.get('socialCardOpen') || this.registry.get('dmRecipient')) return;
    if (!this.consumeInteractPress()) return;
    this.executeInteractTarget(target);
  }

  private syncNearFlagsFromTarget(target: InteractCandidate | null): void {
    // Clear all, then set winner
    const door = target?.kind === 'door'
      ? this.enterableDoors.find((d) => d.building.id === target.id) ?? null
      : null;
    const doorId = door?.building.id ?? null;
    if (doorId !== this.nearDoorId) {
      this.nearDoorId = doorId;
      this.registry.set('nearDoor', door ? {
        id: door.building.id,
        name: door.building.displayName,
        access: door.building.access,
      } : null);
    } else if (!door && this.nearDoorId) {
      this.nearDoorId = null;
      this.registry.set('nearDoor', null);
    }

    if (target?.kind === 'zone') {
      const z = this.interaction.getZones().find((zz) => zz.id === target.id) ?? null;
      this.interaction.setNearZone(z);
    } else {
      this.interaction.clearNearZone();
    }

    const npcName = target?.kind === 'npc' ? target.name : null;
    if (npcName !== this.nearNpcName) {
      this.nearNpcName = npcName;
      this.registry.set('nearNpc', npcName ? { name: npcName } : null);
    }

    const nearTreasure = target?.kind === 'treasure';
    if (nearTreasure !== this.nearTreasure) {
      this.nearTreasure = nearTreasure;
      this.registry.set('nearTreasure', nearTreasure);
    }

    const nearWhale = target?.kind === 'whale';
    if (nearWhale !== this.nearWhale) {
      this.nearWhale = nearWhale;
      this.registry.set('nearWhale', nearWhale);
    }

    const nearCrier = target?.kind === 'town_crier';
    if (nearCrier !== this.nearTownCrier) {
      this.nearTownCrier = nearCrier;
      this.registry.set('nearTownCrier', nearCrier);
    }

    if (target?.kind === 'statue') {
      const rank = Number(String(target.id).split(':')[1] ?? 0);
      this.registry.set('nearStatue', { rank, name: target.name });
    } else {
      this.registry.set('nearStatue', null);
    }
  }

  private executeInteractTarget(target: InteractCandidate): void {
    if (target.kind === 'player') {
      const entry = this.remotePlayerEntries.get(target.id);
      if (!entry || isPresenceStale(entry.lastSeenAt)) {
        this.events.emit('remote-player-gone', { id: target.id });
        return;
      }
      const now = this.time.now;
      if (now - this.lastSocialCardOpenAt < this.socialCardCooldownMs) return;
      this.lastSocialCardOpenAt = now;
      const summary = presenceToSocialSummary({
        id: entry.presenceId,
        username: entry.username,
        x: entry.px,
        y: entry.py,
        appearance: entry.rawAppearance,
        rep: entry.rep,
        holderTier: entry.holderTier,
        level: entry.level,
        rankLabel: entry.rankLabel,
        equippedTitle: entry.equippedTitle,
      }, {
        worldX: entry.px,
        worldY: entry.py,
        direction: entry.facing,
        lastSeenAt: entry.lastSeenAt,
        online: true,
      });
      this.events.emit('remote-player-interact', summary);
      return;
    }

    if (target.kind === 'door') {
      const door = this.enterableDoors.find((d) => d.building.id === target.id);
      if (!door) return;
      if (door.building.access === 'open') {
        this.enterInterior(door.building.id);
        return;
      }
      const now = this.time.now;
      if (now - this.lastInteractFeedbackAt < this.lockedFeedbackSpamMs) return;
      this.lastInteractFeedbackAt = now;
      // Locked / coming-soon buildings still count as intentional interactions.
      this.reportGameplayEvent({
        type: 'LANDMARK_INTERACTED',
        landmarkId: door.building.worldObjectId,
      });
      this.events.emit('door-message', {
        buildingId: door.building.id,
        title: door.building.displayName,
        text: door.building.lockedMessage,
        mode: door.building.access,
      });
      return;
    }

    if (target.kind === 'zone') {
      if (target.action === 'locked' || target.action === 'coming_soon') {
        const now = this.time.now;
        if (now - this.lastInteractFeedbackAt < this.lockedFeedbackSpamMs) return;
        this.lastInteractFeedbackAt = now;
        this.reportGameplayEvent({ type: 'LANDMARK_INTERACTED', landmarkId: target.id });
        this.events.emit('door-message', {
          buildingId: target.id,
          title: target.name,
          text: target.lockedReason || (target.action === 'coming_soon' ? 'Coming soon.' : 'Locked.'),
          mode: target.action === 'coming_soon' ? 'coming_soon' : 'locked',
        });
        return;
      }
      this.reportGameplayEvent({ type: 'LANDMARK_INTERACTED', landmarkId: target.id });
      this.reportGameplayEvent({ type: 'LANDMARK_VISITED', landmarkId: target.id });
      const guide = getNpcByLandmark(target.id);
      if (guide) {
        this.reportGameplayEvent({ type: 'NPC_INTERACTED', npcRole: guide.roleId, npcName: guide.displayName });
      }
      this.events.emit('zone-interact', { id: target.id, name: target.name });
      return;
    }

    if (target.kind === 'npc') {
      const npc = this.npcs.find((n) => n.name === target.name);
      if (!npc) return;
      this.reportGameplayEvent({ type: 'NPC_INTERACTED', npcName: npc.name, npcRole: 'citizen' });
      this.events.emit('npc-interact', {
        name: npc.name,
        personality: npc.personality,
        districtId: npc.districtId,
      });
      return;
    }

    if (target.kind === 'treasure' && this.treasureChest) {
      const reward = this.eventManager.getCurrentEvent()?.definition.reward;
      this.despawnTreasureChest();
      this.events.emit('treasure-interact', {
        rewardAmount: reward?.amount ?? 0,
        rewardLabel: reward?.label ?? 'Treasure found!',
      });
      return;
    }

    if (target.kind === 'whale' && this.whaleMarker) {
      const reward = this.eventManager.getCurrentEvent()?.definition.reward;
      const intel = this.generateFakeWhaleIntel();
      this.despawnWhaleMarker();
      this.events.emit('whale-interact', {
        wallet: intel.wallet,
        buySol: intel.buySol,
        tokenSymbol: intel.tokenSymbol,
        riskLevel: intel.riskLevel,
        rewardAmount: reward?.amount ?? 0,
        rewardLabel: reward?.label ?? 'Whale spotted!',
      });
      return;
    }

    if (target.kind === 'town_crier') {
      const tc = this.townCrier;
      this.events.emit('town-crier-interact', { title: tc?.lines[1] ?? 'Town Crier' });
      this.reportGameplayEvent({ type: 'TOWN_CRIER_TALKED' });
      this.reportGameplayEvent({
        type: 'NPC_INTERACTED',
        npcRole: 'starter_guide',
        npcName: 'Town Crier',
      });
      return;
    }

    if (target.kind === 'statue') {
      const statue = this.hallOfFameStatues.find((s) => `statue:${s.rank}` === target.id);
      if (!statue) return;
      this.reportGameplayEvent({ type: 'BUILDING_ENTERED', buildingId: 'hall-of-fame' });
      this.reportGameplayEvent({ type: 'LANDMARK_INTERACTED', landmarkId: 'fame' });
      this.events.emit('statue-interact', {
        rank: statue.rank,
        name: statue.name,
        rep: statue.rep,
        isPlayer: statue.isPlayer,
      });
    }
  }

  private updateDoorProximity() {
    // Kept for compatibility; Phase 10D uses updateInteractionsUnified.
  }

  private enterInterior(buildingId: string) {
    const building = getEnterableBuilding(buildingId);
    if (!building || this.interiorActive) return;
    this.interiorActive = true;
    this.worldCamera?.setEnabled(false);
    this.registry.set('nearZone', null);
    this.registry.set('nearNpc', null);
    this.registry.set('nearTreasure', false);
    this.registry.set('nearWhale', false);
    this.registry.set('nearStatue', null);
    this.registry.set('nearTownCrier', false);
    this.registry.set('nearDoor', null);
    this.nearDoorId = null;
    this.nearTownCrier = false;
    this.setWorldKeyboardEnabled(false);
    this.scene.launch('InteriorScene', {
      buildingId,
      appearance: this.appearance,
    });
    this.events.emit('interior-entered', {
      buildingId,
      displayName: building.displayName,
    });
    this.markInteriorVisited(buildingId);
    this.events.emit('interior-discovered', { interiorId: buildingId, name: building.displayName });
    this.reportGameplayEvent({ type: 'BUILDING_ENTERED', buildingId });
    this.reportGameplayEvent({ type: 'INTERIOR_ENTERED', buildingId });
    if (building.worldObjectId) {
      this.reportGameplayEvent({ type: 'LANDMARK_VISITED', landmarkId: building.worldObjectId });
    }
    const guide = getNpcByLandmark(building.worldObjectId);
    if (guide) {
      this.reportGameplayEvent({
        type: 'NPC_INTERACTED',
        npcRole: guide.roleId,
        npcName: guide.displayName,
      });
    }
  }

  /** React / HUD can feed mission events without touching private mission state. */
  reportGameplayEvent(event: GameplayEvent): void {
    this.missionBridge.emit(event);
  }

  /** Record an interior as visited (Phase 5), persist + republish if new. */
  private markInteriorVisited(buildingId: string) {
    if (this.visitedInteriors.has(buildingId)) return;
    this.visitedInteriors.add(buildingId);
    patchProgress({ visitedInteriors: Array.from(this.visitedInteriors) });
    this.publishMissionState();
  }

  private exitInterior(buildingId: string) {
    const returnPos = getWorldReturnPosition(buildingId, this.worldW, this.worldH);
    const interior = this.getInteriorScene();
    interior?.shutdownInterior();
    this.scene.stop('InteriorScene');
    this.interiorActive = false;
    this.worldCamera?.setEnabled(true);
    this.setWorldKeyboardEnabled(true);
    if (returnPos) this.teleportTo(returnPos.x, returnPos.y);
    this.events.emit('interior-exited', { buildingId });
  }

  private updateTownCrierProximity() {
    const tc = this.townCrier;
    if (!tc) {
      if (this.nearTownCrier) {
        this.nearTownCrier = false;
        this.registry.set('nearTownCrier', false);
      }
      return;
    }
    const near = Phaser.Math.Distance.Between(this.px, this.py, tc.wx, tc.wy) <= 86;
    if (near !== this.nearTownCrier) {
      this.nearTownCrier = near;
      this.registry.set('nearTownCrier', near);
    }
    if (near && !this.nearDoorId && !this.interaction.nearZoneId && !this.nearNpcName && this.consumeInteractPress()) {
      this.events.emit('town-crier-interact', { title: tc.lines[1] ?? 'Town Crier' });
      this.reportGameplayEvent({ type: 'TOWN_CRIER_TALKED' });
      this.reportGameplayEvent({
        type: 'NPC_INTERACTED',
        npcRole: 'starter_guide',
        npcName: 'Town Crier',
      });
    }
  }

  private publishMissionState() {
    const missions = this.mission.getMissions();
    const active = this.mission.getActiveMission();
    const completedCount = missions.filter(m => m.completed).length;
    const visited = Array.from(this.visitedInteriors);

    this.registry.set('missionState', {
      missions,
      highlightZoneId: this.mission.getHighlightedZoneId(),
      completed: this.mission.isComplete(),
      activeMissionId: active?.id ?? null,
      activeMissionTitle: active?.title ?? null,
      activeMissionDescription: active?.description ?? null,
      completedCount,
      totalCount: missions.length,
      visitedInteriors: visited,
      visitedInteriorsCount: visited.length,
    });

    // Persist mission progress locally so it survives reloads.
    patchProgress({
      completedMissions: this.mission.getCompletedIds(),
      activeMission: active?.id ?? null,
    });
  }

  private getInteriorScene(): InteriorScene | null {
    // Guard: setAppearance() (and other public API) can be called by
    // RugTownGame right after construction, before Phaser boots the scene,
    // when this.scene / this.scene.get is not yet available. Return null so
    // callers using optional chaining simply no-op until the scene is ready.
    if (!this.scene || typeof this.scene.get !== 'function') return null;
    const scene = this.scene.get('InteriorScene');
    return scene instanceof InteriorScene ? scene : null;
  }

  private setWorldKeyboardEnabled(enabled: boolean) {
    const kb = this.input.keyboard;
    if (!kb) return;
    kb.enabled = enabled;
    if (enabled) kb.resetKeys();
  }

  /**
   * Same E-key proximity pattern as updateZoneProximity(), but for talking
   * to NPCs. Landmark zones take priority — if one is active this frame,
   * we clear/skip NPC proximity entirely rather than racing both prompts.
   */
  private updateNpcProximity() {
    if (this.nearDoorId || this.interaction.nearZoneId || this.nearTownCrier) {
      if (this.nearNpcName !== null) {
        this.nearNpcName = null;
        this.registry.set('nearNpc', null);
      }
      return;
    }

    let nearest: NpcData | null = null;
    let nearestDist = NPC_TALK_RADIUS;

    for (const n of this.npcs) {
      const dx = this.px - n.px;
      const dy = this.py - n.py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearest = n;
        nearestDist = dist;
      }
    }

    const nearestName = nearest?.name ?? null;
    if (nearestName !== this.nearNpcName) {
      this.nearNpcName = nearestName;
      this.registry.set('nearNpc', nearest ? { name: nearest.name } : null);
    }

    if (nearest && this.consumeInteractPress()) {
      this.events.emit('npc-interact', {
        name: nearest.name,
        personality: nearest.personality,
        districtId: nearest.districtId,
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     WALKABILITY — delegates to CollisionSystem (Phase 1 refactor)
     NPC wander logic calls these private wrappers so the NPC code
     doesn't need to be touched; all real work is in CollisionSystem.
     ═══════════════════════════════════════════════════════════ */

  private isWalkable(x: number, y: number): boolean {
    return this.collision.isWalkable(x, y);
  }

  private resolveWalk(
    px: number, py: number, vx: number, vy: number, dt: number,
  ): { x: number; y: number } {
    const r = this.collision.resolveWalk(px, py, vx, vy, dt);
    return { x: r.x, y: r.y };
  }

  private remoteAtPointer(pointer: Phaser.Input.Pointer): RemotePlayerEntry | null {
    const hitR2 = (CHAR_H * 0.65) ** 2;
    for (const entry of this.remotePlayerEntries.values()) {
      const dx = pointer.worldX - entry.px;
      const dy = pointer.worldY - entry.py;
      if (dx * dx + dy * dy <= hitR2) return entry;
    }
    return null;
  }

  private hitRemotePlayerAt(pointer: Phaser.Input.Pointer): boolean {
    return this.remoteAtPointer(pointer) !== null;
  }

  private snapToWalkable(x: number, y: number): { x: number; y: number } {
    return this.collision.snapToNearest(x, y);
  }

  /** Phase 8H — is (x,y) an acceptable NPC idle/wander target? Rejects
   *  Spring Water's spawn clearance (Task 6), enterable-building door
   *  clearance (Task 12), an over-capacity bridge region (Task 13), and
   *  targets another NPC is already walking toward (Task 15 pileup
   *  avoidance). Cheap O(population) scan — population is capped at
   *  COMPACT_NPC_CONFIG.totalPopulation (~22), called only on state
   *  transitions (every ~1-4s per NPC), never per-frame. */
  private isGoodNpcTarget(x: number, y: number, self: NpcData): boolean {
    const fountain = getWorldObject('fountain');
    if (fountain) {
      const fx = fountain.x * this.worldW, fy = fountain.y * this.worldH;
      if (Math.hypot(x - fx, y - fy) < COMPACT_NPC_CONFIG.spawnClearanceRadius) return false;
    }

    for (const door of this.enterableDoors) {
      if (Math.hypot(x - door.wx, y - door.wy) < door.radius) return false;
    }

    const bridge = getWorldObject('bridge');
    if (bridge) {
      const bx = bridge.x * this.worldW, by = bridge.y * this.worldH;
      if (Math.hypot(x - bx, y - by) < bridge.interactionRadius) {
        let occupants = 0;
        for (const other of this.npcs) {
          if (other === self) continue;
          if (Math.hypot(other.px - bx, other.py - by) < bridge.interactionRadius) occupants++;
        }
        if (occupants >= COMPACT_NPC_CONFIG.bridgeCapacity) return false;
      }
    }

    for (const other of this.npcs) {
      if (other === self || other.state !== 'walk') continue;
      if (Math.hypot(x - other.targetX, y - other.targetY) < 45) return false;
    }

    return true;
  }

  private randomWalkablePoint(): { wx: number; wy: number } {
    return this.collision?.randomWalkablePoint() ?? { wx: this.plazaX, wy: this.plazaY };
  }

  private setCollisionDebug(visible: boolean) {
    this.collision.setDebugVisible(visible);
  }

  /**
   * The zoom level below which the camera's view area would exceed the
   * world image in either dimension — i.e. the point past which empty
   * background starts showing. Below this, `viewport / zoom` (the area
   * actually visible) would be bigger than the world image, so the
   * floor is whichever axis needs the most zoom to still cover it.
   * Called every frame so resize/rotate/fullscreen are always correct.
   */
  private computeZoomMin(): number {
    if (this.worldW <= 0 || this.worldH <= 0) return ZOOM_MIN;
    const vw = this.scale.width;
    const vh = this.scale.height;
    if (vw <= 0 || vh <= 0) return ZOOM_MIN;
    return Math.max(vw / this.worldW, vh / this.worldH, ZOOM_MIN);
  }

  /* ═══════════════════════════════════════════════════════════
     REWARD FEEDBACK
     World-space floating text (e.g. "+5 REP") plus a brief camera
     flash, used for reward claims. Does not touch player/NPC motion,
     zoom, or world bounds — purely an additive visual effect layered
     above the existing player rendering.
     ═══════════════════════════════════════════════════════════ */
  private spawnFloatingText(text: string, color = '#e8b84b') {
    const obj = this.add.text(this.px, this.py - CHAR_H * 0.9, text, {
      fontFamily: '"Cinzel", serif',
      fontSize: '13px',
      fontStyle: 'bold',
      color,
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(20);

    this.floatingTexts.push({ obj, vy: -26, life: 1100, maxLife: 1100 });
  }

  private updateFloatingTexts(delta: number) {
    const dt = delta / 1000;
    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const ft = this.floatingTexts[i];
      ft.life -= delta;
      ft.obj.y += ft.vy * dt;
      ft.obj.setAlpha(Math.max(0, ft.life / ft.maxLife));
      if (ft.life <= 0) {
        ft.obj.destroy();
        this.floatingTexts.splice(i, 1);
      }
    }
  }

  /**
   * Plays a reward claim effect: floating text above the player's head
   * plus a brief, subtle gold camera flash. Called by the HUD when a
   * reward (e.g. the fountain's daily REP) is claimed.
   */
  playRewardEffect(text = '+5 REP') {
    if (this.interiorActive) {
      this.getInteriorScene()?.playRewardEffect(text);
      return;
    }
    this.spawnFloatingText(text);
    this.cameras.main.flash(320, 232, 184, 75);
  }

  /**
   * Shows a small speech bubble above the player's head for `duration` ms.
   * Used by the chat panel — sending a message echoes it here.
   */
  showPlayerSpeech(text: string, duration = 3000) {
    if (this.interiorActive) {
      this.getInteriorScene()?.showPlayerSpeech(text, duration);
      return;
    }
    this.playerSpeech.setText(text);
    this.playerSpeech.setVisible(true);
    this.playerSpeechUntil = duration;
  }

  /**
   * Brief squash/stretch "pop" on the player sprite — used by emotes as
   * their local animation. Purely cosmetic; doesn't touch movement.
   */
  playEmoteAnimation() {
    if (this.interiorActive) {
      this.getInteriorScene()?.playEmoteAnimation();
      return;
    }
    this.emotePulseUntil = EMOTE_PULSE_DURATION;
  }

  /** How many citizens currently have a visible speech bubble, city-wide
   *  — the single source of truth NPC_SPEECH_MAX_VISIBLE is enforced
   *  against (req. D1). Cheap: a flat scan of speechShowUntil, no
   *  GameObject property reads. */
  private countVisibleNpcSpeechBubbles(): number {
    let count = 0;
    for (const n of this.npcs) if (n.speechShowUntil > 0) count++;
    return count;
  }

  /**
   * Shows `text` in a random NPC's existing speech bubble (same fields
   * the NPC's own ambient chatter already uses). Used by simulated city
   * events that want to surface "from" a citizen — doesn't touch NPC
   * movement/behavior, just borrows the bubble for a moment. Respects
   * the same global visible-bubble cap as everything else.
   */
  showNpcEventSpeech(text: string) {
    if (this.npcs.length === 0) return;
    if (this.countVisibleNpcSpeechBubbles() >= NPC_SPEECH_MAX_VISIBLE) return;
    const n = Phaser.Utils.Array.GetRandom(this.npcs);
    n.speech.setText(text);
    n.speech.setVisible(true);
    n.speechShowUntil = NPC_SPEECH_DURATION;
  }

  /**
   * Phase 6 — brief floating label above a district centre (living city events).
   * World-space only; does not follow the player.
   */
  showDistrictFloatingText(fx: number, fy: number, text: string, color = '#e8c67a') {
    // Phase 8K Task 10 — at most MAX_VISIBLE_EVENT_MESSAGES floating
    // banners on screen at once; a short FIFO queue rather than letting
    // them stack over the (now much smaller/denser) central plaza.
    while (this.floatingTexts.length >= MAX_VISIBLE_EVENT_MESSAGES) {
      const oldest = this.floatingTexts.shift();
      oldest?.obj.destroy();
    }
    const x = fx * this.worldW;
    const y = fy * this.worldH - 48;
    const obj = this.add.text(x, y, text, {
      fontFamily: '"Cinzel", serif',
      fontSize: '12px',
      fontStyle: 'bold',
      color,
      backgroundColor: 'rgba(4,8,12,0.82)',
      padding: { x: 8, y: 4 },
      stroke: '#000000',
      strokeThickness: 3,
      align: 'center',
    }).setOrigin(0.5, 1).setDepth(18);

    this.floatingTexts.push({ obj, vy: -18, life: 2800, maxLife: 2800 });
  }

  /** Number keys 1–4 trigger quick emotes (handled by GamePage). */
  private updateQuickEmoteKeys() {
    if (Phaser.Input.Keyboard.JustDown(this.keyEmote1)) {
      this.events.emit('player-quick-emote', 'wave');
    } else if (Phaser.Input.Keyboard.JustDown(this.keyEmote2)) {
      this.events.emit('player-quick-emote', 'laugh');
    } else if (Phaser.Input.Keyboard.JustDown(this.keyEmote3)) {
      this.events.emit('player-quick-emote', 'bullish');
    } else if (Phaser.Input.Keyboard.JustDown(this.keyEmote4)) {
      this.events.emit('player-quick-emote', 'rug-alert');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     EVENT ENGINE (Phase 2)
     WorldScene's side of the EventManager contract: publish lifecycle
     state to the registry so React can read it, and apply/revert the
     three local effects a data-driven event can ask for — weather,
     music, and citizen behaviour. EventManager itself knows nothing
     about Phaser; this is the one place that bridges the two.
     ═══════════════════════════════════════════════════════════ */

  /** Read-only passthrough — lets React (or anything else holding the
   *  scene) inspect the current event without reaching into the
   *  registry, mirroring getPlayerPos()/getWorldSize() below. */
  getCurrentEvent(): EventInstance | null {
    return this.eventManager.getCurrentEvent();
  }

  private dialogueFor(instance: EventInstance, phase: EventPhase): string | null {
    const match = instance.definition.dialogue.find(d => d.phase === phase);
    return match?.text ?? null;
  }

  private handleEventPhaseChange(instance: EventInstance | null, _prevPhase: EventPhase) {
    this.registry.set('eventPhase', instance?.phase ?? 'idle');
    this.registry.set('currentEvent', instance ? {
      id: instance.definition.id,
      title: instance.definition.title,
      description: instance.definition.description,
      rarity: instance.definition.rarity,
      phase: instance.phase,
      phaseDuration: instance.phaseDuration,
      phaseStartedAt: instance.phaseStartedAt,
      reward: instance.definition.reward,
      location: instance.definition.location,
      dialogue: this.dialogueFor(instance, instance.phase),
      chainedFrom: instance.chainedFrom ?? null,
    } : null);

    if (!instance) {
      this.revertEventOverrides();
      this.despawnTreasureChest();
      this.despawnWhaleMarker();
      this.despawnTownCrier();
      this.revertCrowdReaction();
      return;
    }

    if (instance.phase === 'announcement') {
      // Every event gets a Town Crier during Announcement — unlike the
      // treasure chest/whale marker, this one isn't tied to a specific
      // event id (req. 1/2). spawnTownCrier() triggers its own (smaller,
      // tighter) crowd reaction internally.
      this.spawnTownCrier(instance);
    } else if (instance.phase === 'live') {
      this.applyEventOverrides(instance.definition);
      // Only their own definition ever spawns a marker — every other
      // event leaves both untouched (treasure-hunt req. 11 / same rule
      // for whale-alert).
      if (instance.definition.id === 'treasure-hunt') {
        this.spawnTreasureChest(instance.definition);
      }
      if (instance.definition.id === 'whale-alert') {
        this.spawnWhaleMarker(instance.definition);
      }
      // The Crier's job (and his crowd) is done the moment the event
      // goes Live — clear it before the Live-phase crowd (if any)
      // takes over, so the two never overlap.
      this.despawnTownCrier();
      this.revertCrowdReaction();
      this.triggerLiveCrowdReaction(instance.definition);
    } else if (instance.phase === 'completed') {
      this.revertEventOverrides();
      this.despawnTreasureChest();
      this.despawnWhaleMarker();
      this.despawnTownCrier(); // safety net in case Live was skipped somehow
      this.revertCrowdReaction();
    }

    // Citizens get a chance to "say" the event's line for this phase,
    // reusing the existing ambient speech-bubble helper — no new UI.
    const line = this.dialogueFor(instance, instance.phase);
    if (line && (instance.phase === 'announcement' || instance.phase === 'live' || instance.phase === 'completed')) {
      this.showNpcEventSpeech(line);
    }
  }

  private applyEventOverrides(def: EventDefinition) {
    this.activeWeather = def.weatherOverride ?? null;
    if (!this.activeWeather) this.weatherGraphics.setVisible(false);

    // Music override: SoundManager only supports one-shot named effects
    // today (no per-track switching) — playing the existing 'event' cue
    // is the honest stand-in until a real per-event track system exists.
    // def.musicOverride is still carried through to the registry above
    // so a future audio layer has the id to key off of immediately.
    if (def.musicOverride) soundManager.play('event');

    if (def.citizenBehaviour.mode === 'gather') {
      this.applyEventCitizenGather(def);
    }
  }

  private revertEventOverrides() {
    this.activeWeather = null;
    this.weatherGraphics.setVisible(false);
    this.revertEventCitizenGather();
  }

  /** Pulls a sample of citizens toward the event's location for the
   *  Live phase. Snapshots each one's home/wander radius first so
   *  revertEventCitizenGather() can put them back exactly as they were
   *  — this never permanently changes an NPC's normal routine. */
  private applyEventCitizenGather(def: EventDefinition) {
    if (this.npcs.length === 0) return;
    const landmark = def.location.landmarkId ? getWorldObject(def.location.landmarkId) : undefined;
    const { wx, wy } = landmark
      ? toWorldPosition(landmark, this.worldW, this.worldH)
      : { wx: this.plazaX, wy: this.plazaY };

    const count = Math.min(def.citizenBehaviour.citizenCount ?? 8, this.npcs.length);
    const sample = Phaser.Utils.Array.Shuffle(this.npcs.slice()).slice(0, count);

    this.eventGatherSnapshot = sample.map(npc => ({
      npc, homeX: npc.homeX, homeY: npc.homeY, wanderRadius: npc.wanderRadius,
    }));

    // Evenly-sloted ring (+ small per-slot jitter that's mathematically
    // capped at well under one slot-width, so neighboring citizens can
    // never land on each other) instead of pure independent random x/y
    // offsets — spreads the gather out and avoids stacking (req. E),
    // while still looking organic rather than a perfect circle.
    const slotWidth = (Math.PI * 2) / sample.length;
    sample.forEach((npc, i) => {
      const angle = i * slotWidth + Phaser.Math.FloatBetween(-slotWidth * 0.35, slotWidth * 0.35);
      const dist = Phaser.Math.Between(35, 95);
      const home = this.snapToWalkable(wx + Math.cos(angle) * dist, wy + Math.sin(angle) * dist);
      npc.homeX = home.x;
      npc.homeY = home.y;
      npc.wanderRadius = 60;
      npc.state = 'walk';
      npc.targetX = npc.homeX;
      npc.targetY = npc.homeY;
      npc.stateTimer = Phaser.Math.Between(800, 1600);
    });
  }

  private revertEventCitizenGather() {
    if (!this.eventGatherSnapshot) return;
    this.eventGatherSnapshot.forEach(({ npc, homeX, homeY, wanderRadius }) => {
      npc.homeX = homeX;
      npc.homeY = homeY;
      npc.wanderRadius = wanderRadius;
      npc.state = 'pause';
      npc.stateTimer = Phaser.Math.Between(400, 1200);
    });
    this.eventGatherSnapshot = null;
  }

  /** Lazily builds a small fixed pool of rain drops, positioned later
   *  each frame as fractions (0-1) of the current camera view — cheap
   *  at any zoom level since it never depends on world size directly. */
  private ensureRainDrops() {
    if (this.rainDrops.length > 0) return;
    for (let i = 0; i < 90; i++) {
      this.rainDrops.push({
        ox: Math.random(),
        oy: Math.random(),
        len: 10 + Math.random() * 8,
        speed: 280 + Math.random() * 160,
      });
    }
  }

  /** Purely cosmetic overlay — never touches collision/camera/background.
   *  No-ops (and hides the layer) whenever no weather event is Live. */
  private updateWeatherEffect(delta: number) {
    if (this.activeWeather !== 'rain') {
      if (this.weatherGraphics.visible) this.weatherGraphics.setVisible(false);
      return;
    }

    this.ensureRainDrops();
    this.weatherGraphics.setVisible(true);
    this.weatherGraphics.clear();
    this.weatherGraphics.lineStyle(1, 0x9fd0e8, 0.35);

    const view = this.cameras.main.worldView;
    const dt = delta / 1000;

    for (const drop of this.rainDrops) {
      drop.oy += (drop.speed * dt) / Math.max(1, view.height);
      if (drop.oy > 1) { drop.oy -= 1; drop.ox = Math.random(); }
      const x = view.x + drop.ox * view.width;
      const y = view.y + drop.oy * view.height;
      this.weatherGraphics.lineBetween(x, y, x - 3, y + drop.len);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     TREASURE HUNT CHEST
     Only ever exists while the 'treasure-hunt' event definition is
     Live — spawned/despawned from handleEventPhaseChange(). Everything
     here is gated on `this.treasureChest` being non-null, so it's a
     true no-op for every other event (req. 11).
     ═══════════════════════════════════════════════════════════ */

  /** Picks a world position for the chest. Treasure Hunt has no fixed
   *  landmark (location.landmarkId is null — "somewhere in RugTown"),
   *  so this tries random open spots (not inside collision) before
   *  falling back to the plaza if it somehow can't find one. Events
   *  anchored to a real landmark would just spawn there instead. */
  private pickTreasureSpawnPosition(def: EventDefinition): { wx: number; wy: number } {
    const landmark = def.location.landmarkId ? getWorldObject(def.location.landmarkId) : undefined;
    if (landmark) return toWorldPosition(landmark, this.worldW, this.worldH);

    // No fixed landmark → drop it on a random reachable road/plaza point so
    // the player can always walk to it.
    return this.randomWalkablePoint();
  }

  /** Simple pixel-art chest — code-generated Graphics, same technique
   *  as every character/prop in the game (no sprite assets). */
  private drawTreasureChestGraphics(g: Phaser.GameObjects.Graphics) {
    g.clear();
    g.fillStyle(0x5a3a1e);
    g.fillRoundedRect(-14, -6, 28, 16, 3);
    g.fillStyle(0x3a2410);
    g.fillRoundedRect(-15, -14, 30, 10, 4);
    g.fillStyle(0xe8b84b);
    g.fillRect(-15, -14, 30, 2);
    g.fillRect(-15, -6, 28, 2);
    g.fillStyle(0xe8b84b);
    g.fillRoundedRect(-3, -8, 6, 6, 1);
    g.fillStyle(0x3a2410, 0.85);
    g.fillRect(-1, -6, 2, 3);
  }

  private spawnTreasureChest(def: EventDefinition) {
    this.despawnTreasureChest(); // never let two chests stack

    const { wx, wy } = this.pickTreasureSpawnPosition(def);

    const glow = this.add.graphics().setDepth(13).setPosition(wx, wy);
    const body = this.add.graphics().setDepth(14).setPosition(wx, wy);
    this.drawTreasureChestGraphics(body);
    const label = this.add.text(wx, wy - 24, '✦ Treasure Chest ✦', {
      fontFamily: '"Cinzel", serif',
      fontSize: '8px',
      color: '#e8b84b',
      backgroundColor: 'rgba(4,8,12,0.78)',
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1).setDepth(14.2);

    this.treasureChest = { wx, wy, glow, body, label };
    this.registry.set('treasureChest', { wx, wy });
  }

  private despawnTreasureChest() {
    if (!this.treasureChest) return;
    this.treasureChest.glow.destroy();
    this.treasureChest.body.destroy();
    this.treasureChest.label.destroy();
    this.treasureChest = null;
    this.registry.set('treasureChest', null);
    if (this.nearTreasure) {
      this.nearTreasure = false;
      this.registry.set('nearTreasure', false);
    }
  }

  /** Gold pulse — alpha/scale driven by the same always-running
   *  animTick used for the player's idle breathing, redrawn cheaply
   *  each frame (cheap: it's just a handful of concentric circles). */
  private updateTreasureChest() {
    if (!this.treasureChest) return;
    const t = this.animTick / 1000;
    const pulse = (Math.sin(t * 2.4) + 1) / 2; // 0..1

    this.treasureChest.glow.clear();
    const glowA = 0.12 + pulse * 0.18;
    for (let r = 26; r > 0; r -= 5) {
      this.treasureChest.glow.fillStyle(0xe8b84b, glowA * (1 - r / 26));
      this.treasureChest.glow.fillCircle(0, 0, r);
    }
    this.treasureChest.glow.setScale(1 + pulse * 0.18);
    this.treasureChest.body.setScale(1 + pulse * 0.06);
  }

  /** Same E-key proximity pattern as updateZoneProximity()/
   *  updateNpcProximity(), lowest priority of the three — only checked
   *  when neither a landmark zone nor an NPC claimed this frame's
   *  proximity/E-press already. */
  private updateTreasureProximity() {
    if (!this.treasureChest) return;

    if (this.nearDoorId || this.interaction.nearZoneId || this.nearNpcName || this.nearTownCrier) {
      if (this.nearTreasure) {
        this.nearTreasure = false;
        this.registry.set('nearTreasure', false);
      }
      return;
    }

    const dx = this.px - this.treasureChest.wx;
    const dy = this.py - this.treasureChest.wy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const near = dist <= TREASURE_INTERACT_RADIUS;

    if (near !== this.nearTreasure) {
      this.nearTreasure = near;
      this.registry.set('nearTreasure', near);
    }

    if (near && this.consumeInteractPress()) {
      // Reward comes from the live engine state, not a stale snapshot —
      // req. 10 (no double-claim) is enforced by destroying the chest
      // (and its proximity/registry state) immediately, synchronously,
      // before the event is even emitted.
      const reward = this.eventManager.getCurrentEvent()?.definition.reward;
      this.despawnTreasureChest();
      this.events.emit('treasure-interact', {
        rewardAmount: reward?.amount ?? 0,
        rewardLabel: reward?.label ?? 'Treasure found!',
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     WHALE ALERT MARKER
     Only ever exists while the 'whale-alert' event definition is Live —
     spawned/despawned from handleEventPhaseChange(). Citizens gathering
     toward Whale Tower is already handled by the existing, generic
     applyEventCitizenGather() (whale-alert's citizenBehaviour.mode is
     'gather' in EventDefinitions.ts) — nothing new needed for that part.
     ═══════════════════════════════════════════════════════════ */

  /** Simple pixel-art whale — code-generated Graphics, same technique
   *  as every character/prop in the game (no sprite assets). */
  private drawWhaleMarkerGraphics(g: Phaser.GameObjects.Graphics) {
    g.clear();
    g.fillStyle(0x1e4a6e);
    g.fillEllipse(0, 0, 34, 18);
    g.fillStyle(0x3a7aa8, 0.85);
    g.fillEllipse(2, 5, 24, 9);
    g.fillStyle(0x1e4a6e);
    g.fillTriangle(14, -2, 27, -11, 27, 9);
    g.fillStyle(0x0a0a0a);
    g.fillCircle(-11, -3, 1.6);
    g.fillStyle(0x9fd0e8, 0.85);
    g.fillRect(-15, -15, 2, 6);
    g.fillRect(-17, -17, 2, 4);
    g.fillRect(-13, -17, 2, 4);
  }

  /** Clearly-fake flavor data for the Whale Alert modal — generated
   *  fresh at inspection time, never tied to any real wallet/chain. */
  private generateFakeWhaleIntel(): { wallet: string; buySol: number; tokenSymbol: string; riskLevel: string } {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const chunk = (n: number) => {
      let s = '';
      for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    };
    const tokens = ['$RUG', '$MOON', '$DEGEN', '$ALPHA', '$WHALE', '$PUMP', '$GHOST'];
    const risks = ['Low', 'Medium', 'High', 'Extreme'];

    return {
      wallet: `${chunk(6)}...${chunk(4)}`,
      buySol: Math.round((40 + Math.random() * 860) * 10) / 10,
      tokenSymbol: Phaser.Utils.Array.GetRandom(tokens),
      riskLevel: Phaser.Utils.Array.GetRandom(risks),
    };
  }

  private spawnWhaleMarker(def: EventDefinition) {
    this.despawnWhaleMarker(); // never let two markers stack

    const landmark = def.location.landmarkId ? getWorldObject(def.location.landmarkId) : undefined;
    const { wx, wy } = landmark
      ? toWorldPosition(landmark, this.worldW, this.worldH)
      : { wx: this.plazaX, wy: this.plazaY };

    const glow = this.add.graphics().setDepth(13).setPosition(wx, wy);
    const body = this.add.graphics().setDepth(14).setPosition(wx, wy);
    this.drawWhaleMarkerGraphics(body);
    const label = this.add.text(wx, wy - 26, '✦ Whale Alert ✦', {
      fontFamily: '"Cinzel", serif',
      fontSize: '8px',
      color: '#5cb8ec',
      backgroundColor: 'rgba(4,8,12,0.78)',
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1).setDepth(14.2);

    this.whaleMarker = { wx, wy, glow, body, label };
    this.registry.set('whaleMarker', { wx, wy });
  }

  private despawnWhaleMarker() {
    if (!this.whaleMarker) return;
    this.whaleMarker.glow.destroy();
    this.whaleMarker.body.destroy();
    this.whaleMarker.label.destroy();
    this.whaleMarker = null;
    this.registry.set('whaleMarker', null);
    if (this.nearWhale) {
      this.nearWhale = false;
      this.registry.set('nearWhale', false);
    }
  }

  /** Two-tone gold/blue pulse — feels distinct from the treasure chest's
   *  plain gold glow, "special" per req. 2, via a slow crossfade between
   *  the two colors layered under the alpha pulse. */
  private updateWhaleMarker() {
    if (!this.whaleMarker) return;
    const t = this.animTick / 1000;
    const pulse = (Math.sin(t * 2.0) + 1) / 2;       // 0..1, fast alpha/scale pulse
    const colorMix = (Math.sin(t * 0.8) + 1) / 2;     // 0..1, slow gold↔blue crossfade

    this.whaleMarker.glow.clear();
    for (let r = 34; r > 0; r -= 6) {
      const a = (0.10 + pulse * 0.16) * (1 - r / 34);
      this.whaleMarker.glow.fillStyle(0xe8b84b, a * colorMix);
      this.whaleMarker.glow.fillCircle(0, 0, r);
      this.whaleMarker.glow.fillStyle(0x5cb8ec, a * (1 - colorMix));
      this.whaleMarker.glow.fillCircle(0, 0, r);
    }
    this.whaleMarker.glow.setScale(1 + pulse * 0.16);
    this.whaleMarker.body.setScale(1 + pulse * 0.05);
  }

  /** Same E-key proximity pattern as updateTreasureProximity() — lowest
   *  priority, only checked when neither a landmark zone nor an NPC
   *  claimed this frame's proximity/E-press already. */
  private updateWhaleProximity() {
    if (!this.whaleMarker) return;

    if (this.nearDoorId || this.interaction.nearZoneId || this.nearNpcName || this.nearTownCrier) {
      if (this.nearWhale) {
        this.nearWhale = false;
        this.registry.set('nearWhale', false);
      }
      return;
    }

    const dx = this.px - this.whaleMarker.wx;
    const dy = this.py - this.whaleMarker.wy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const near = dist <= WHALE_INTERACT_RADIUS;

    if (near !== this.nearWhale) {
      this.nearWhale = near;
      this.registry.set('nearWhale', near);
    }

    if (near && this.consumeInteractPress()) {
      // Same one-shot-claim pattern as the treasure chest: destroy the
      // marker synchronously before emitting, so "grants REP once per
      // event" (req. 8) is enforced by there being nothing left to
      // press E on a second time.
      const reward = this.eventManager.getCurrentEvent()?.definition.reward;
      const intel = this.generateFakeWhaleIntel();
      this.despawnWhaleMarker();
      this.events.emit('whale-interact', {
        wallet: intel.wallet,
        buySol: intel.buySol,
        tokenSymbol: intel.tokenSymbol,
        riskLevel: intel.riskLevel,
        rewardAmount: reward?.amount ?? 0,
        rewardLabel: reward?.label ?? 'Whale spotted!',
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     TOWN CRIER
     Appears during the Announcement phase of ANY event — unlike the
     treasure chest/whale marker, this isn't tied to one definition id.
     Purely ambient: no proximity prompt, no E-press, no reward. Drawn
     with BitmapCharacter like the player/citizens, plus a bell marker
     so he reads as a special character at a glance.
     ═══════════════════════════════════════════════════════════ */

  /** "Somewhere in RugTown"-style events have no fixed landmark, so the
   *  Crier defaults to Spawn Fountain (req. 3); events with a real
   *  landmark get him posted right there instead. */
  private pickTownCrierSpawnPosition(def: EventDefinition): { wx: number; wy: number } {
    const landmark = def.location.landmarkId ? getWorldObject(def.location.landmarkId) : undefined;
    if (landmark) return toWorldPosition(landmark, this.worldW, this.worldH);
    return { wx: this.plazaX, wy: this.plazaY };
  }

  private spawnTownCrier(instance: EventInstance) {
    this.despawnTownCrier(); // never let two stack (e.g. a very fast re-announce)

    const def = instance.definition;
    const { wx, wy } = this.pickTownCrierSpawnPosition(def);

    const bitmap = new BitmapCharacter(
      this,
      npcAppearanceFromId('town-crier', listNpcBodies()),
      { depth: 14, visualScale: PLAYER_VISUAL_SCALE },
    );
    bitmap.setPosition(wx, wy);
    bitmap.setFacing('down');

    const bell = this.add.text(wx, wy, '🔔', { fontSize: '13px' })
      .setOrigin(0.5, 1).setDepth(14.3);
    const label = this.add.text(wx, wy, 'Town Crier [NPC]', {
      fontFamily: '"Cinzel", serif',
      fontSize: '7px',
      fontStyle: 'bold',
      color: '#1a1408',
      backgroundColor: 'rgba(232,184,75,0.96)',
      padding: { x: 4, y: 2 },
      stroke: '#5a3800',
      strokeThickness: 2,
      resolution: Math.max(2, window.devicePixelRatio || 1),
    }).setOrigin(0.5, 1).setDepth(14.2);
    const speech = this.add.text(wx, wy, '', {
      fontFamily: '"Cinzel", serif',
      fontSize: '9px',
      color: '#e8d8c0',
      backgroundColor: 'rgba(10,14,18,0.92)',
      padding: { x: 6, y: 4 },
      align: 'center',
      wordWrap: { width: 160 },
    }).setOrigin(0.5, 1).setDepth(14.4).setVisible(false);

    const shortDescription = def.description.length > 70
      ? `${def.description.slice(0, 67)}...`
      : def.description;

    this.townCrier = {
      wx, wy, bitmap, bell, label, speech,
      lines: ['Hear ye! Hear ye!', def.title, shortDescription],
      lineIndex: 0,
      lineTimer: 0,
      animTick: 0,
    };
    this.registry.set('townCrier', { wx, wy });

    this.showTownCrierLine(0);
    this.faceNpcsTowardTownCrier(wx, wy);
    // Nearby citizens don't just turn to face him — a crowd actually
    // gathers closer for the announcement (req. 1), tighter/closer than
    // the bigger Live-phase crowd reactions below, but still spread out
    // (req. E) rather than stacking on his exact position.
    this.triggerCrowdReaction(wx, wy, 10, 25, 75);

    soundManager.play('bell');
    this.events.emit('town-crier-announce', { title: def.title });
  }

  private despawnTownCrier() {
    if (!this.townCrier) return;
    this.townCrier.bitmap.destroy();
    this.townCrier.bell.destroy();
    this.townCrier.label.destroy();
    this.townCrier.speech.destroy();
    this.townCrier = null;
    this.registry.set('townCrier', null);
    this.nearTownCrier = false;
    this.registry.set('nearTownCrier', false);
  }

  private showTownCrierLine(index: number) {
    if (!this.townCrier) return;
    this.townCrier.lineIndex = index;
    this.townCrier.speech.setText(this.townCrier.lines[index]);
    this.townCrier.speech.setVisible(true);
    this.townCrier.lineTimer = TOWN_CRIER_LINE_DURATION;
  }

  /** Ambience only — a one-time nudge when the Crier shows up, not a
   *  continuous force. Citizens already mid-walk will naturally turn
   *  away again the next time their own movement updates `facing`. */
  private faceNpcsTowardTownCrier(wx: number, wy: number) {
    for (const n of this.npcs) {
      const dx = wx - n.px;
      const dy = wy - n.py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > TOWN_CRIER_FACE_RADIUS) continue;
      if (Math.abs(dx) >= Math.abs(dy)) {
        n.facing = dx > 0 ? 'right' : 'left';
      } else {
        n.facing = dy > 0 ? 'down' : 'up';
      }
    }
  }

  private updateTownCrier(delta: number) {
    const tc = this.townCrier;
    if (!tc) return;
    tc.animTick += delta;

    tc.bitmap.setPosition(tc.wx, tc.wy);
    tc.bitmap.setFacing('down');
    tc.bitmap.update(delta, 0, 0, false);

    const headYLocal = -TARGET_DISPLAY_HEIGHT * PLAYER_VISUAL_SCALE * 0.5;
    const labelY = tc.wy + headYLocal - 6;
    tc.label.setPosition(Math.round(tc.wx), Math.round(labelY));
    tc.bell.setPosition(tc.wx, labelY - 14);
    tc.speech.setPosition(tc.wx, labelY - 26);

    tc.lineTimer -= delta;
    if (tc.lineTimer <= 0) {
      this.showTownCrierLine((tc.lineIndex + 1) % tc.lines.length);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     HALL OF FAME STATUES
     A permanent fixture near the 'fame' landmark, NOT event-driven —
     unlike the chest/whale/crier, these always exist once GamePage has
     pushed leaderboard data at least once. GamePage owns the actual
     leaderboard (local-only, no backend, no real users — see
     LEADERBOARD_NPCS in GamePage.tsx); this is purely the read-only
     world-rendering side of it.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Rebuilds the 3 statues from fresh top-3 leaderboard rows. Safe to
   * call repeatedly (e.g. every time REP changes the ranking) — always
   * tears down and redraws rather than trying to patch in place, since
   * with only 3 statues that's simpler and cheap.
   */
  setHallOfFameStatues(rows: { rank: number; name: string; rep: number; isPlayer: boolean }[]) {
    this.despawnHallOfFameStatues();

    const fame = getWorldObject('fame');
    if (!fame) return;
    const { wx: baseX, wy: baseY } = toWorldPosition(fame, this.worldW, this.worldH);

    // #1 front-center, #2/#3 flanking slightly behind — reads as a
    // podium without needing any new art.
    const offsets = [
      { dx: 0, dy: -46 },
      { dx: -58, dy: 6 },
      { dx: 58, dy: 6 },
    ];

    rows.slice(0, 3).forEach((row, i) => {
      const offset = offsets[i] ?? { dx: 0, dy: 0 };
      const wx = baseX + offset.dx;
      const wy = baseY + offset.dy;
      const accentColor = STATUE_RANK_COLOR[row.rank] ?? STATUE_RANK_COLOR[3];

      const glow = this.add.graphics().setDepth(11).setPosition(wx, wy);
      const body = this.add.graphics().setDepth(12).setPosition(wx, wy);
      this.drawStatueGraphics(body, accentColor);

      const label = this.add.text(wx, wy - 28, `#${row.rank} ${row.name}${row.isPlayer ? ' (You)' : ''}`, {
        fontFamily: '"Cinzel", serif',
        fontSize: '7px',
        fontStyle: 'bold',
        color: '#1a1408',
        backgroundColor: `#${accentColor.toString(16).padStart(6, '0')}`,
        padding: { x: 4, y: 2 },
      }).setOrigin(0.5, 1).setDepth(12.2);

      this.hallOfFameStatues.push({
        rank: row.rank, name: row.name, rep: row.rep, isPlayer: row.isPlayer,
        wx, wy, glow, body, label,
      });
    });
  }

  private despawnHallOfFameStatues() {
    if (this.hallOfFameStatues.length === 0) return;
    for (const s of this.hallOfFameStatues) {
      s.glow.destroy();
      s.body.destroy();
      s.label.destroy();
    }
    this.hallOfFameStatues = [];
    if (this.nearStatueRank !== null) {
      this.nearStatueRank = null;
      this.registry.set('nearStatue', null);
    }
  }

  /** Simple stone pedestal + bust — code-generated Graphics, same
   *  technique as every character/prop in the game. Deliberately plain
   *  stone-gray (not an outfit color) so the rank-colored glow/trim is
   *  what reads as "gold/silver/bronze", not the statue material. */
  private drawStatueGraphics(g: Phaser.GameObjects.Graphics, accentColor: number) {
    g.clear();
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(0, 19, 26, 7);

    g.fillStyle(0x2a2a2e);
    g.fillRoundedRect(-15, 6, 30, 13, 2);
    g.fillStyle(accentColor, 0.95);
    g.fillRect(-15, 6, 30, 2);

    g.fillStyle(0x9a9aa0);
    g.fillRoundedRect(-9, -10, 18, 18, 3);
    g.fillStyle(0x7a7a80, 0.6);
    g.fillRect(2, -10, 7, 18);

    g.fillStyle(0xaaaaae);
    g.fillCircle(0, -16, 7);
    g.fillStyle(0x7a7a80, 0.5);
    g.fillCircle(3, -15, 5);
  }

  /** Slow, calm pulse — statues are a permanent fixture, not a
   *  time-limited event marker, so the glow is gentler than the
   *  treasure chest/whale marker's. */
  private updateHallOfFameStatues() {
    if (this.hallOfFameStatues.length === 0) return;
    const t = this.animTick / 1000;
    const pulse = (Math.sin(t * 1.1) + 1) / 2;

    for (const s of this.hallOfFameStatues) {
      const accentColor = STATUE_RANK_COLOR[s.rank] ?? STATUE_RANK_COLOR[3];
      s.glow.clear();
      const glowA = 0.08 + pulse * 0.1;
      for (let r = 22; r > 0; r -= 5) {
        s.glow.fillStyle(accentColor, glowA * (1 - r / 22));
        s.glow.fillCircle(0, -4, r);
      }
      s.glow.setScale(1 + pulse * 0.1);
    }
  }

  /** Same E-key proximity pattern as the other markers — lowest
   *  priority of all of them (zones → NPCs → treasure → whale → statue),
   *  checked against whichever statue is nearest. */
  private updateStatueProximity() {
    if (this.hallOfFameStatues.length === 0) return;

    if (this.nearDoorId || this.interaction.nearZoneId || this.nearNpcName || this.nearTreasure || this.nearWhale || this.nearTownCrier) {
      if (this.nearStatueRank !== null) {
        this.nearStatueRank = null;
        this.registry.set('nearStatue', null);
      }
      return;
    }

    let nearest: (typeof this.hallOfFameStatues)[number] | null = null;
    let nearestDist = STATUE_INTERACT_RADIUS;
    for (const s of this.hallOfFameStatues) {
      const dx = this.px - s.wx;
      const dy = this.py - s.wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= nearestDist) {
        nearest = s;
        nearestDist = dist;
      }
    }

    const nearRank = nearest?.rank ?? null;
    if (nearRank !== this.nearStatueRank) {
      this.nearStatueRank = nearRank;
      this.registry.set('nearStatue', nearest ? { rank: nearest.rank, name: nearest.name } : null);
    }

    if (nearest && this.consumeInteractPress()) {
      this.reportGameplayEvent({ type: 'BUILDING_ENTERED', buildingId: 'hall-of-fame' });
      this.reportGameplayEvent({ type: 'LANDMARK_INTERACTED', landmarkId: 'fame' });
      this.events.emit('statue-interact', {
        rank: nearest.rank,
        name: nearest.name,
        rep: nearest.rep,
        isPlayer: nearest.isPlayer,
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     CROWD REACTION
     A second, larger wave of citizens reacting to a major-event moment
     — Town Crier announcing, or Whale Alert/Treasure Hunt/Fireworks/
     Dance Festival going Live. Reuses the same home/wanderRadius/state
     nudge technique as the existing (smaller) applyEventCitizenGather(),
     but with its own snapshot array and its own NPC sample (always
     excluding whoever that system already pulled in), so the two never
     collide over the same citizen.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Pulls `count` citizens (not already part of the existing event-gather
   * sample) toward (wx, wy), each with a randomized offset/speed/timing
   * so the crowd reads as organic rather than a single-file line (req. 5),
   * plus a staggered "crowd reaction" speech bubble per citizen (req. 6).
   * Always reverts any previous crowd reaction first — only one is ever
   * active at a time.
   */
  private triggerCrowdReaction(wx: number, wy: number, count: number, spreadMin = 35, spreadMax = 150) {
    this.revertCrowdReaction();
    if (this.npcs.length === 0) return;

    const alreadyGathered = new Set(this.eventGatherSnapshot?.map(e => e.npc) ?? []);
    const pool = this.npcs.filter(n => !alreadyGathered.has(n));
    if (pool.length === 0) return;

    const sample = Phaser.Utils.Array.Shuffle(pool.slice()).slice(0, Math.min(count, pool.length));
    this.crowdReactionSnapshot = sample.map(npc => ({
      npc, homeX: npc.homeX, homeY: npc.homeY, wanderRadius: npc.wanderRadius,
    }));

    // Same evenly-sloted-ring-plus-jitter technique as
    // applyEventCitizenGather() — wider radius here since this is the
    // bigger "whole crowd" reaction, not the tight inner circle (req. E).
    const slotWidth = (Math.PI * 2) / sample.length;
    sample.forEach((npc, i) => {
      const angle = i * slotWidth + Phaser.Math.FloatBetween(-slotWidth * 0.35, slotWidth * 0.35);
      const dist = Phaser.Math.Between(spreadMin, spreadMax);
      const home = this.snapToWalkable(wx + Math.cos(angle) * dist, wy + Math.sin(angle) * dist);
      npc.homeX = home.x;
      npc.homeY = home.y;
      npc.wanderRadius = 50;
      npc.state = 'walk';
      npc.targetX = npc.homeX;
      npc.targetY = npc.homeY;
      // Generous + randomized per-citizen — long enough for most to
      // actually arrive given their own (also randomized) speed, short
      // enough to naturally vary who gets there first.
      npc.stateTimer = Phaser.Math.Between(7000, 14000);

      // Only some of the crowd actually gets a scheduled speech bubble
      // (req. D4 — reduce crowd/event bubble spam); the global
      // NPC_SPEECH_MAX_VISIBLE cap is re-checked when the timer actually
      // fires, since visible-bubble counts shift during the stagger window.
      if (Math.random() < 0.45) {
        this.time.delayedCall(Phaser.Math.Between(300, 4000), () => {
          if (this.countVisibleNpcSpeechBubbles() >= NPC_SPEECH_MAX_VISIBLE) return;
          const line = Phaser.Utils.Array.GetRandom(CROWD_REACTION_LINES);
          npc.speech.setText(line);
          npc.speech.setVisible(true);
          npc.speechShowUntil = NPC_SPEECH_DURATION;
        });
      }
    });
  }

  private revertCrowdReaction() {
    if (!this.crowdReactionSnapshot) return;
    this.crowdReactionSnapshot.forEach(({ npc, homeX, homeY, wanderRadius }) => {
      npc.homeX = homeX;
      npc.homeY = homeY;
      npc.wanderRadius = wanderRadius;
      npc.state = 'pause';
      npc.stateTimer = Phaser.Math.Between(400, 1200);
    });
    this.crowdReactionSnapshot = null;
  }

  /** Dispatches the Live-phase crowd reaction for the 4 named events
   *  (req. 2/3/4) — every other event simply doesn't match any case, so
   *  it gets no crowd reaction beyond the existing small gather, if any. */
  private triggerLiveCrowdReaction(def: EventDefinition) {
    switch (def.id) {
      case 'whale-alert': {
        const whale = getWorldObject('whale');
        if (whale) {
          const { wx, wy } = toWorldPosition(whale, this.worldW, this.worldH);
          this.triggerCrowdReaction(wx, wy, 18);
        }
        break;
      }
      case 'treasure-hunt':
        if (this.treasureChest) {
          this.triggerCrowdReaction(this.treasureChest.wx, this.treasureChest.wy, 16);
        }
        break;
      case 'fireworks':
      case 'dance-festival':
        this.triggerCrowdReaction(this.plazaX, this.plazaY, 20);
        break;
      default:
        break;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     INPUT SETUP
     ═══════════════════════════════════════════════════════════ */
  private setupInput() {
    const kb = this.input.keyboard!;

    this.keyW     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyA     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyS     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.keyD     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyUp    = kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.keyDown  = kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keyLeft  = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    this.keyZoomIn    = kb.addKey(Phaser.Input.Keyboard.KeyCodes.PLUS);
    this.keyZoomOut   = kb.addKey(Phaser.Input.Keyboard.KeyCodes.MINUS);
    this.keyZoomReset = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ZERO);
    this.keyRecenter  = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyE         = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.keyEmote1    = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.keyEmote2    = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.keyEmote3    = kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyEmote4    = kb.addKey(Phaser.Input.Keyboard.KeyCodes.FOUR);
    // C key collision-debug shortcut removed for public demo (use Settings panel)

    kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ADD).on('down', () => {
      if (this.interiorActive) return;
      this.worldCamera?.setTargetZoom((this.worldCamera?.getTargetZoom() ?? ZOOM_DEFAULT) + ZOOM_STEP * 2);
    });
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_SUBTRACT).on('down', () => {
      if (this.interiorActive) return;
      this.worldCamera?.setTargetZoom((this.worldCamera?.getTargetZoom() ?? ZOOM_DEFAULT) - ZOOM_STEP * 2);
    });
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ZERO).on('down', () => {
      if (this.interiorActive) return;
      this.worldCamera?.requestRecenter(true);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API — called from GamePage.tsx / RugTownGame.ts
     ═══════════════════════════════════════════════════════════ */

  teleportTo(x: number, y: number) {
    const snapped = this.snapToWalkable(
      Phaser.Math.Clamp(x, 0, this.worldW),
      Phaser.Math.Clamp(y, 0, this.worldH),
    );
    this.px = snapped.x;
    this.py = snapped.y;
    this.player.setPosition(this.px, this.py);
    this.velX = 0;
    this.velY = 0;
    this.worldCamera?.snapFollowToPlayer(this.px, this.py);
    this.registry.set('playerX', this.px);
    this.registry.set('playerY', this.py);
  }

  panTo(x: number, y: number, duration = 600) {
    if (this.interiorActive) return;
    const tx = Phaser.Math.Clamp(x, 0, this.worldW);
    const ty = Phaser.Math.Clamp(y, 0, this.worldH);
    this.tweens.add({
      targets:  this.player,
      x:        tx,
      y:        ty,
      duration,
      ease:     'Sine.easeInOut',
      onUpdate: () => {
        this.px = this.player.x;
        this.py = this.player.y;
      },
      onComplete: () => {
        this.px = tx;
        this.py = ty;
        this.velX = 0;
        this.velY = 0;
      },
    });
  }

  setTargetZoom(z: number) {
    if (this.interiorActive) return;
    this.worldCamera?.setTargetZoom(z);
  }

  /**
   * "Reset camera" (⌂) — default zoom + smooth recenter to player.
   * Does NOT move the player. Uses WorldCameraController (no startFollow).
   */
  resetCamera() {
    if (this.interiorActive) return;
    this.worldCamera?.requestRecenter(true);
  }

  /** Smooth recenter only (SPACE / floating Recenter) — keeps current zoom. */
  recenterCamera() {
    if (this.interiorActive) return;
    this.worldCamera?.requestRecenter(false);
  }

  /** Player bitmap appearance. Safe to call before or after create(). */
  setAppearance(appearance: CharacterAppearanceV1 | unknown) {
    this.appearance = coerceAppearanceV1(appearance);
    this.bitmapPlayer?.setAppearance(this.appearance);
    this.getInteriorScene()?.setAppearance(this.appearance);
    if (this.bitmapPlayer) this.drawPlayer();
  }

  /**
   * Call before Phaser boots create() so refresh restore lands at the
   * last safe position instead of Spring Water.
   */
  setInitialSpawn(pos: { x: number; y: number } | null | undefined) {
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      this.pendingSpawn = { x: pos.x, y: pos.y };
    } else {
      this.pendingSpawn = null;
    }
  }

  getPlayerBitmap(): BitmapCharacter | null {
    return this.bitmapPlayer;
  }

  /**
   * Apply server-trusted public loadouts to remote players (Phase 10L).
   * Presence movement packets must not be the authority for cosmetics.
   */
  applyTrustedRemoteAppearances(map: Record<string, CharacterAppearanceV1 | unknown>) {
    for (const [id, appearance] of Object.entries(map)) {
      const existing = this.remotePlayerEntries.get(id);
      if (!existing) continue;
      const next = coerceAppearanceV1(appearance);
      existing.bitmap.setAppearance(next);
      existing.rawAppearance = next;
    }
  }

  getPlayerPos() {
    return { x: this.px, y: this.py };
  }

  getWorldSize() {
    return { w: this.worldW, h: this.worldH };
  }

  /**
   * Suspends/resumes this scene's keyboard input (movement, zoom, E, C —
   * everything). Used while the chat text input has focus so typing
   * doesn't also move the player or toggle the collision overlay.
   * resetKeys() on re-enable clears any key held down while disabled, so
   * nothing gets stuck "pressed".
   */
  setKeyboardEnabled(enabled: boolean) {
    if (this.interiorActive) {
      this.getInteriorScene()?.setKeyboardEnabled(enabled);
      return;
    }
    this.setWorldKeyboardEnabled(enabled);
  }

  /** Settings panel's collision-debug toggle — mirrors the C key. */
  setCollisionDebugVisible(visible: boolean) {
    this.collision?.setDebugVisible(visible);
  }

  setAssetBoundsDebugVisible(visible: boolean) {
    this.buildingGenerator?.getWorldAssetLoader()?.setBoundsDebugVisible(visible);
  }

  setAssetAnchorsDebugVisible(visible: boolean) {
    this.buildingGenerator?.getWorldAssetLoader()?.setAnchorsDebugVisible(visible);
  }

  setAssetRoadClearanceDebugVisible(visible: boolean) {
    this.buildingGenerator?.getWorldAssetLoader()?.setRoadClearanceDebugVisible(visible);
  }

  setAssetPlayerDepthDebugVisible(visible: boolean) {
    this.buildingGenerator?.getWorldAssetLoader()?.setPlayerDepthDebugVisible(visible);
  }

  getWorldAssetLoadStats() {
    return this.buildingGenerator?.getWorldAssetLoader()?.getStats();
  }

  /** Highlights the landmark label for the given zone ID with a gold pulse.
   *  Pass null to clear the highlight. Safe to call before create() returns. */
  setActiveMissionZone(zoneId: string | null) {
    this.buildingGenerator?.setMissionZone(zoneId);
  }

  /**
   * Mobile virtual joystick — x/y each -1..1, combined magnitude already
   * clamped to <=1 by the caller. (0, 0) means "not touched", which is
   * the default and leaves keyboard movement completely unaffected.
   */
  setVirtualMove(x: number, y: number) {
    if (this.interiorActive) {
      this.getInteriorScene()?.setVirtualMove(x, y);
      return;
    }
    this.virtualMoveX = Phaser.Math.Clamp(x, -1, 1);
    this.virtualMoveY = Phaser.Math.Clamp(y, -1, 1);
  }

  /** Mobile interact button — same effect as a single E key press. */
  requestInteract() {
    if (this.interiorActive) {
      this.getInteriorScene()?.requestInteract();
      return;
    }
    this.virtualInteractRequested = true;
  }

  /**
   * Show an emote bubble + pop animation on a specific remote player.
   * Called from GamePage when a broadcast emote is received.
   * No-op if the entry doesn't exist yet (player not yet in presence state).
   */
  showRemotePlayerEmote(presenceId: string, text: string, duration: number) {
    const entry = this.remotePlayerEntries.get(presenceId);
    if (!entry) return;
    entry.speech.setText(text);
    entry.speech.setVisible(true);
    entry.speechUntil    = duration;
    entry.emotePulseUntil = EMOTE_PULSE_DURATION;
  }

  /* ═══════════════════════════════════════════════════════════
     REALTIME PRESENCE — REMOTE PLAYER RENDERING
     Called from React (GamePage) on every presence sync event.
     ═══════════════════════════════════════════════════════════ */

  /**
   * Update the set of remote real players rendered in-scene.
   * Creates, updates, or destroys Phaser graphics objects as needed.
   * The local player (localId) is always excluded from rendering.
   * Safe to call before create() — returns immediately in that case.
   */
  setRemotePlayers(players: PresencePayload[], localId: string) {
    if (!this.bitmapPlayer) return; // scene not yet initialised

    const activeIds = new Set(
      players.filter(p => p.id !== localId).map(p => p.id)
    );

    // Remove entries whose owner disconnected
    this.remotePlayerEntries.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        entry.glow.destroy();
        entry.bitmap.destroy();
        entry.label.destroy();
        entry.speech.destroy();
        this.remotePlayerEntries.delete(id);
        this.events.emit('remote-player-gone', { id });
        if (this.selectedRemotePlayerId === id) this.selectedRemotePlayerId = null;
        if (this.stickyInteractId === id) {
          this.stickyInteractId = null;
          this.stickyInteractSince = 0;
        }
      }
    });

    // Create or update entries for every present remote player
    for (const p of players) {
      if (p.id === localId) continue;

      const existing = this.remotePlayerEntries.get(p.id);
      if (existing) {
        existing.targetX          = p.x;
        existing.targetY          = p.y;
        const nextApp = decodeCharacterAppearance(p.appearance, assetExists);
        const nextRev = p.appearanceRev ?? existing.appearanceRev;
        const appearanceChanged = p.appearanceRev != null
          ? p.appearanceRev !== existing.appearanceRev
          : encodeCharacterAppearance(nextApp) !== encodeCharacterAppearance(existing.rawAppearance);
        if (appearanceChanged) {
          existing.bitmap.setAppearance(nextApp);
          existing.rawAppearance = nextApp;
          existing.appearanceRev = nextRev;
        }
        existing.rep              = p.rep;
        existing.holderTier       = p.holderTier;
        existing.level            = p.level;
        existing.rankLabel        = p.rankLabel;
        existing.equippedTitle    = p.equippedTitle;
        existing.lastSeenAt       = Date.now();
        if (existing.username !== p.username) {
          existing.username = p.username;
          existing.label.setText(this.formatRemoteNameplate(p.username, p.rep, p.holderTier));
        }
      } else {
        const glow   = this.add.graphics().setDepth(8);
        const bitmap = new BitmapCharacter(
          this,
          decodeCharacterAppearance(p.appearance, assetExists),
          { depth: 10, visualScale: REMOTE_PLAYER_VISUAL_SCALE },
        );
        bitmap.setPosition(p.x, p.y);
        // Cyan label — visually distinct from Citizens (grey) and the
        // local player's label (gold).
        const label  = this.add.text(0, 0, this.formatRemoteNameplate(p.username, p.rep, p.holderTier), {
          fontFamily: NAMEPLATE_FONT,
          fontSize:   '12px',
          fontStyle:  'bold',
          color:      '#40e8f8',
          backgroundColor: 'rgba(0,12,20,0.94)',
          padding: { x: 5, y: 2 },
          stroke: '#001828',
          strokeThickness: 4,
          resolution: WORLD_TEXT_RESOLUTION,
          align: 'center',
        }).setOrigin(0.5, 1).setDepth(11);

        const speech = this.add.text(0, 0, '', {
          fontFamily: NAMEPLATE_FONT,
          fontSize:   '12px',
          color:      '#e8d8c0',
          backgroundColor: 'rgba(10,14,18,0.94)',
          padding: { x: 7, y: 4 },
          stroke: '#000000',
          strokeThickness: 3,
          align: 'center',
          resolution: WORLD_TEXT_RESOLUTION,
        }).setOrigin(0.5, 1).setDepth(12).setVisible(false);

        this.remotePlayerEntries.set(p.id, {
          glow, bitmap, label, speech,
          px: p.x, py: p.y,
          targetX: p.x, targetY: p.y,
          animTick: 0,
          facing: 'down',
          isMoving: false,
          blinkTimerNext: Phaser.Math.Between(2000, 6000),
          blinkUntil: 0,
          username: p.username,
          speechUntil: 0,
          emotePulseUntil: 0,
          presenceId:    p.id,
          rep:           p.rep,
          holderTier:    p.holderTier,
          rawAppearance: decodeCharacterAppearance(p.appearance, assetExists),
          appearanceRev: p.appearanceRev,
          level:         p.level,
          rankLabel:     p.rankLabel,
          equippedTitle: p.equippedTitle,
          lastSeenAt:    Date.now(),
          selected:      false,
        });
      }
    }
  }

  private updateRemotePlayers(delta: number) {
    this.remotePlayerEntries.forEach(entry => {
      entry.animTick += delta;

      const dx = entry.targetX - entry.px;
      const dy = entry.targetY - entry.py;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 0.5) {
        // Network-smooth lerp: closes ~half the gap every ~80ms at 60fps.
        const factor = Math.min(1, (delta / 1000) * 12);
        entry.px += dx * factor;
        entry.py += dy * factor;
        entry.isMoving = dist > 6;
        // Task 6/16 — the network payload carries no facing; infer it from
        // the interpolated position delta, same dominant-axis rule as the
        // local player and NPCs.
        if (Math.abs(dx) >= Math.abs(dy)) {
          entry.facing = dx > 0 ? 'right' : 'left';
        } else {
          entry.facing = dy > 0 ? 'down' : 'up';
        }
      } else {
        entry.isMoving = false;
      }

      // Speech bubble countdown
      if (entry.speechUntil > 0) {
        entry.speechUntil -= delta;
        if (entry.speechUntil <= 0) entry.speech.setVisible(false);
      }

      // Emote pulse countdown
      if (entry.emotePulseUntil > 0) {
        entry.emotePulseUntil = Math.max(0, entry.emotePulseUntil - delta);
      }

      // Task 16 — remote players blink too now, for animation parity with
      // the local player/NPCs. Purely local/visual, never sent over the
      // network.
      if (entry.blinkUntil > 0) {
        entry.blinkUntil -= delta;
      } else {
        entry.blinkTimerNext -= delta;
        if (entry.blinkTimerNext <= 0) {
          entry.blinkUntil = 120;
          entry.blinkTimerNext = Phaser.Math.Between(2000, 6000);
        }
      }

      // Remote players always draw every frame — they're real people and
      // smooth animation is critical for a good multiplayer feel.
      this.drawRemotePlayer(entry, delta);
    });
  }

  private drawRemotePlayer(entry: RemotePlayerEntry, delta: number) {
    const vx = entry.targetX - entry.px;
    const vy = entry.targetY - entry.py;
    entry.bitmap.setPosition(entry.px, entry.py);
    entry.bitmap.setFacing(entry.facing);
    entry.bitmap.update(delta, vx, vy, entry.isMoving);

    // Cyan glow (gold = local player, nothing = NPC citizens)
    entry.glow.clear();
    for (const r of [22, 14, 7]) {
      entry.glow.fillStyle(0x00c8e8, 0.05 * (1 - r / 24));
      entry.glow.fillCircle(0, TARGET_DISPLAY_HEIGHT * 0.15, r * REMOTE_PLAYER_VISUAL_SCALE);
    }
    // Selected interaction target — clearer ring at feet
    if (entry.selected) {
      entry.glow.lineStyle(2, 0x40e8f8, 0.85);
      entry.glow.strokeCircle(0, TARGET_DISPLAY_HEIGHT * 0.2, 16 * REMOTE_PLAYER_VISUAL_SCALE);
      entry.glow.fillStyle(0x40e8f8, 0.12);
      entry.glow.fillCircle(0, TARGET_DISPLAY_HEIGHT * 0.2, 16 * REMOTE_PLAYER_VISUAL_SCALE);
    }
    entry.glow.setPosition(entry.px, entry.py);

    const headYLocal = -TARGET_DISPLAY_HEIGHT * REMOTE_PLAYER_VISUAL_SCALE * 0.55;
    // Anchor from character centre → head; foot-relative stability via rounded px
    entry.label.setPosition(Math.round(entry.px), Math.round(entry.py + headYLocal - 4));
    const invZoom = Phaser.Math.Clamp(1 / Math.max(0.85, this.currentZoom), 0.75, 1.12);
    entry.label.setScale(invZoom);
    if (entry.selected) {
      entry.label.setStyle({ color: '#a8f8ff', backgroundColor: 'rgba(0,24,36,0.96)' });
    } else {
      entry.label.setStyle({ color: '#40e8f8', backgroundColor: 'rgba(0,12,20,0.94)' });
    }
    entry.speech.setPosition(entry.px, entry.py + headYLocal - 14);
  }

  private formatRemoteNameplate(username: string, rep: number, holderTier: string): string {
    const short = ellipsizeName(username, 12);
    const tier = holderTier && holderTier !== 'None' ? ` · ${holderTier[0]}` : '';
    // Single line — multi-line plates collide much more on mobile.
    return `${short} · ${rep.toLocaleString()} REP${tier}`;
  }
}
