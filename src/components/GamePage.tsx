import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { RugTownGame } from '../game/RugTownGame';
import { WorldScene, NPC_SPEECH_BY_PERSONALITY, type NpcPersonality } from '../game/scenes/WorldScene';
import { getWorldObject, WORLD_OBJECTS } from '../game/world/WorldObjects';
import type { CharacterAppearanceV1 } from '../game/characters/appearance/CharacterAppearanceDefaults';
import { getCanonicalPlayerAppearance } from '../game/characters/appearance/CanonicalPlayerAppearance';
import { decodeCharacterAppearance, migrateCharacterAppearance, encodeCharacterAppearance } from '../game/characters/appearance/CharacterAppearanceCodec';
import { characterAppearanceService } from '../game/characters/appearance/CharacterAppearanceService';
import { assetExists } from '../game/characters/assets/CharacterAssetRegistry';
import { soundManager, type SoundChannel } from '../audio/SoundManager';
import type { EventRarity, EventReward, EventLocation, EventPhase as EnginePhase } from '../game/events/EventTypes';
import { EVENT_DEFINITIONS } from '../game/events/EventDefinitions';
import { MarketPanel } from './MarketPanel';
import { NoticeBoardPanel } from './NoticeBoardPanel';
import { getGenericBuildingModal } from './building/BuildingModalCopy';
import { AlphaLoungePanel } from './AlphaLoungePanel';
import { emitGameplayEvent } from '../game/missions/MissionEventBridge';
import { HudCharacterPortrait } from './HudCharacterPortrait';
import { fetchTrendingSolanaTokens, type MarketToken } from '../services/dexscreener';
import { saveBadge, saveInventoryItem, saveDistrictUnlock, updateLastSeen } from '../lib/profile';
import { loadProgress, patchProgress } from '../lib/progress';
import { saveRugTownSession } from '../game/persistence/RugTownSessionStore';
import { discoverHiddenQuest, completeHiddenQuest } from '../lib/hiddenQuests';
import { recordDailyParticipation, recordActivityHeartbeat, getMyStreak } from '../lib/activity';
import { MissionHQPanel } from './MissionHQPanel';
import {
  pickLivingCityEvent,
  LIVING_CITY_EVENT_MIN_GAP,
  LIVING_CITY_EVENT_MAX_GAP,
} from '../game/systems/LivingCityEvents';
import { getDistrictDialogueLines } from '../game/world/NpcDistrictDialogue';
import { createCityChannel, removeCityChannel, flattenPresenceState, syncRealtimeAuth, type PresencePayload } from '../lib/presence';
import { SocialPlayerCard } from './SocialPlayerCard';
import { DirectMessagePanel } from './DirectMessagePanel';
import { SocialHubPanel } from './social/SocialHubPanel';
import { ReportPlayerDialog, ReportMessageDialog } from './social/ReportDialogs';
import { ModerationOperationsPanel } from './social/ModerationOperationsPanel';
import { PartyPanel } from './party/PartyPanel';
import { WorldEventCentrePanel } from './events/WorldEventCentrePanel';
import { WorldEventHud } from './events/WorldEventHud';
import { DayNightOverlay } from './world/DayNightOverlay';
import { TournamentCentrePanel } from './tournaments/TournamentCentrePanel';
import { GuildPanel } from './guilds/GuildPanel';
import { RugTownGuildPanel } from './guild/RugTownGuildPanel';
import { QuestArchivePanel } from './QuestArchivePanel';
import { reportGuildGameplayEvent } from '../lib/guild/GuildProgressBridge';
import { recordRewardPoints, DEFAULT_MISSION_RP } from '../lib/rewards/RewardPointsService';
import { shortenWalletAddress } from '../lib/wallet/SolanaWalletProviders';
import { characterService } from '../lib/character';
import { LevelUpToast } from './LevelUpToast';
import { PlayerProfilePanel } from './PlayerProfilePanel';
import { RewardCentrePanel } from './RewardCentrePanel';
import { RewardOperationsPanel } from './RewardOperationsPanel';
import {
  presenceToSocialSummary,
  toDmRecipient,
  type DirectMessageRecipient,
  type SocialPlayerSummary,
} from '../lib/social';
import { socialService, sanitizeCityChat, type FriendshipState } from '../lib/social/index';
import { partyService } from '../lib/party';
import {
  progressionService,
  type LevelUpNotice,
  type PlayerProgression,
} from '../game/progression';
import { rewardService } from '../game/rewards';
import { achievementService } from '../game/achievements';
import { AchievementCentrePanel } from './achievements/AchievementCentrePanel';
import { TitleLockerPanel } from './achievements/TitleLockerPanel';
import { SeasonPassPanel } from './achievements/SeasonPassPanel';
import { rankDisplayName } from '../game/progression/RankLadder';
import { titleDisplayName } from '../game/progression/TitleCatalog';
import { WORLD_DISTRICTS } from '../game/world/WorldDistricts';
import { CompactMinimap } from './minimap/CompactMinimap';
import { ExpandedWorldMap } from './minimap/ExpandedWorldMap';
import {
  loadMapFilters,
  publishMinimapUiDebug,
  useMinimapLiveData,
} from './minimap/useMinimapLiveData';
import { buildMinimapLandmarks } from '../game/minimap/MinimapLandmarks';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { LEVEL_DEFINITIONS, type LevelObjectiveType } from '../game/levels/LevelDefinitions';
import { notificationQueue } from '../lib/notificationQueue';
import { NotificationBanner } from './NotificationBanner';
import { PointsLeaderboardPanel } from './PointsLeaderboardPanel';

/*
  GamePage.tsx
  ────────────
  Mounts the Phaser canvas fullscreen with a React HUD overlay on top.

  Layout from Image 2 (gameplay-master):
  ┌──────────────────────────────────────────────────────────────────┐
  │ TOP-LEFT: logo + player card                                     │
  │ TOP-RIGHT: [not needed for world view]                           │
  ├──────────────────────────────────────────────────────────────────┤
  │                                                                  │
  │  LEFT SIDEBAR (narrow)    │  PHASER CANVAS  │  RIGHT SIDEBAR    │
  │  Player card              │  fills center   │  Minimap          │
  │  Quick stats              │                 │  Camera info      │
  │                           │                 │                   │
  ├──────────────────────────────────────────────────────────────────┤
  │ BOTTOM ACTION BAR — gold-bordered icon row (Image 2 bottom)      │
  └──────────────────────────────────────────────────────────────────┘

  UI style from Image 3 (ui-bible):
  - Dark near-black panels (#0a0c0e to #0d1117)
  - Thick gold borders with filigree/ornament corners
  - Gold header bars at top of each panel
  - Cinzel serif font for all headings
  - Gold shimmer on hover states
*/

/* ─── Types ─── */
interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

interface NearZone {
  id: string;
  name: string;
}

interface NearDoor {
  id: string;
  name: string;
  access: 'open' | 'locked' | 'coming_soon';
}

interface NearNpc {
  name: string;
}

interface MissionEntry {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  chapterTitle: string;
  objectiveHint?: string;
  rewardXp: number;
  rewardRep: number;
  objectives?: Array<{
    id: string;
    label: string;
    current: number;
    target: number;
    done: boolean;
  }>;
  category?: string;
}

interface MissionRegistryState {
  missions: MissionEntry[];
  highlightZoneId: string | null;
  completed: boolean;
  activeMissionId: string | null;
  activeMissionTitle: string | null;
  activeMissionDescription: string | null;
  completedCount: number;
  totalCount: number;
  visitedInteriors: string[];
  visitedInteriorsCount: number;
}

const EMPTY_MISSION_STATE: MissionRegistryState = {
  missions: [],
  highlightZoneId: null,
  completed: false,
  activeMissionId: null,
  activeMissionTitle: null,
  activeMissionDescription: null,
  completedCount: 0,
  totalCount: 0,
  visitedInteriors: [],
  visitedInteriorsCount: 0,
};

interface InteriorRegistryState {
  active: boolean;
  buildingId: string | null;
  displayName: string | null;
}

interface InteriorPromptState {
  kind: 'exit' | 'feature';
  label: string;
}

interface InteriorPromptState {
  kind: 'exit' | 'feature';
  label: string;
}

interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  kind: 'player' | 'npc' | 'event';
}

/** Realtime connection state, surfaced in the HUD. */
type ConnState = 'connecting' | 'online' | 'offline';

/** Wire format for a broadcast chat message (req: id/senderId/sender/text/timestamp). */
interface ChatBroadcast {
  id: string;
  senderId: string;
  sender: string;
  text: string;
  timestamp: number;
}

/** Globally-unique id for a chat broadcast, used for cross-client dedup. */
function makeChatMessageId(senderId: string): string {
  return `${senderId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

/* ─── Event HUD (Phase 2 Event Engine) ───
   Shape WorldScene publishes to the registry's 'currentEvent' key (see
   handleEventPhaseChange in WorldScene.ts) — a flattened, JSON-friendly
   snapshot of the engine's EventInstance, not the instance itself. Reusing
   the engine's own field types (EventRarity/EventReward/EventLocation)
   keeps this in sync with EventDefinitions.ts without duplicating them. */
interface RegistryCurrentEvent {
  id: string;
  title: string;
  description: string;
  rarity: EventRarity;
  phase: EnginePhase;
  phaseDuration: number;
  phaseStartedAt: number;
  reward: EventReward;
  location: EventLocation;
  dialogue: string | null;
  /** id of the event that chained into this one (Phase 4 Event Chain
   *  System), or null if it was picked the normal random way. */
  chainedFrom: string | null;
}

const EVENT_PHASE_LABELS: Record<EnginePhase, string> = {
  idle: 'Idle',
  countdown: 'Starting Soon',
  announcement: 'Announcement',
  live: 'Live Now',
  completed: 'Completed',
  cooldown: 'Cooldown',
};

function formatEventTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
}

/** One city-chat line per phase the event is worth announcing for —
 *  Idle/Cooldown are deliberately silent so the chat doesn't spam on
 *  every event's wind-down. */
function eventChatLine(evt: RegistryCurrentEvent): { icon: string; text: string } | null {
  switch (evt.phase) {
    case 'countdown':
      return { icon: '⏳', text: `${evt.title} is brewing near ${evt.location.displayName}...` };
    case 'announcement':
      return { icon: '📢', text: `Citizens of RugTown — ${evt.description}` };
    case 'live':
      return { icon: '🔥', text: `${evt.title} is live now at ${evt.location.displayName}!` };
    case 'completed':
      return {
        icon: '✅',
        text: evt.reward.type !== 'none' ? `${evt.title} has ended. Reward: ${evt.reward.label}` : `${evt.title} has ended.`,
      };
    default:
      return null;
  }
}

/* ─── Event Chain System (Phase 4) ───
   Fires once, the first time a chained event's countdown shows up, in
   addition to (not instead of) the normal eventChatLine() above — see
   the poll loop. `sourceTitle` is resolved from EVENT_DEFINITIONS by
   the chainedFrom id WorldScene published. ─── */
const CHAIN_TRIGGER_LINES: ((sourceTitle: string) => string)[] = [
  () => 'One event has triggered another...',
  (sourceTitle) => `The city reacts to the ${sourceTitle}.`,
  (sourceTitle) => `Word spreads fast after the ${sourceTitle}.`,
  () => 'The story of RugTown continues...',
];

/** Short "Today's Story" log line for an event reaching its Live phase
 *  — deliberately terser than eventChatLine()'s chat phrasing. Other
 *  phases don't get an automatic entry; the rest of the story log is
 *  filled in by player actions (treasure/whale claims). */
function storyLogLineForLive(evt: RegistryCurrentEvent): string {
  const verbs = ['started', 'began', 'is underway'];
  const verb = verbs[Math.floor(Math.random() * verbs.length)];
  return `${evt.title} ${verb}`;
}

/* ─── Action bar items matching Image 2 bottom bar ─── */
const ACTION_BAR_ITEMS = [
  { icon: '💬', label: 'Chat',        key: 'C' },
  { icon: '😄', label: 'Emotes',      key: 'E' },
  { icon: '🎒', label: 'Inventory',   key: 'I' },
  { icon: '📋', label: 'Quests',      key: 'Q' },
  { icon: '◆', label: 'Rewards',     key: 'R' },
  { icon: '⏱', label: 'Events',      key: 'V' },
  { icon: '👥', label: 'Social',      key: 'F' },
  { icon: '⚔', label: 'Party',       key: 'P' },
  { icon: '🏛️', label: 'Mission HQ',  key: 'J' },
  { icon: '🏆', label: 'Leaderboard', key: 'L' },
  { icon: '💎', label: 'Holder',      key: 'H' },
  { icon: '🗺️',  label: 'Map',         key: 'M' },
  { icon: '📜', label: 'Story',       key: '' },
  { icon: '⚙️',  label: 'Settings',    key: '' },
];

/* ─── Minimap landmark colors — keyed by WorldObject id, one source
   of truth (src/game/world/WorldObjects.ts) drives position/name/icon ─── */
const LANDMARK_COLORS: Record<string, string> = {
  fountain: '#e8b84b',
  market:   '#d4a030',
  fame:     '#c8902a',
  bridge:   '#b07820',
  alpha:    '#e8c840',
  whale:    '#a08030',
  notice:   '#d4a030',
  coffee:   '#c8902a',
  park:     '#8a7028',
};

/* ─── Interaction zone modal content — flavor text only, no backend ─── */
const ZONE_INFO: Record<string, { title: string; sub: string }> = {
  fountain:             { title: 'Spring Water',        sub: 'The heart of RugTown — make your mark' },
  market:               { title: 'Meme Market',         sub: 'Trends, gossip, and street-level alpha' },
  market_shop:          { title: 'Market Stalls',       sub: 'Browse the city\'s active traders' },
  bridge:               { title: 'Main Bridge',         sub: 'Crossing into new districts' },
  fame:                 { title: 'Hall of Fame',        sub: '🏆 Leaderboard & Top 3 Champion Statues' },
  whale:                { title: 'Whale Tower',         sub: 'Monument to RugTown\'s biggest players' },
  notice:               { title: 'Notice Board',        sub: '📋 City missions, events & community leads' },
  alpha:                { title: 'Alpha Club (Lv 30+)', sub: '🔒 Specialist lounge — advanced leads & quests' },
  cashback:             { title: 'Quest Archive',       sub: '📜 Completed missions, clues & hidden quest log' },
  arena:                { title: 'Challenge Arena',     sub: '⚔ Timed trials, speed runs & gauntlets' },
  coffee:               { title: 'Social Hub & Café',  sub: '☕ Gather, chat, and meet the city' },
  government:           { title: 'Mission HQ',          sub: '🎯 Chapter missions, assignments & trials' },
  trading_academy:      { title: 'Trading Academy',     sub: 'Lessons before leverage' },
  financial_office:     { title: 'Financial Office',    sub: 'Progression ledgers & rep records' },
  holder_bank:          { title: 'Holder Bank',         sub: 'Account preview' },
  research_observatory: { title: 'Research Observatory',sub: 'Event signals and hidden clues' },
  tournament_hall:      { title: 'Tournament Hall',     sub: 'Challenge desk & weekly brackets' },
  nft_gallery:          { title: 'NFT Gallery',         sub: 'Cosmetic exhibits only' },
  nft_creator_studio:   { title: 'Creator Studio',      sub: 'Appearance workshop' },
  park:                 { title: 'Park Entrance',       sub: 'Quiet green meet-up spot' },
};

const FAME_LEADERBOARD = [
  { rank: 1, name: 'WhaleGhost',     rep: 9420 },
  { rank: 2, name: 'AlphaAisha',     rep: 8110 },
  { rank: 3, name: 'ChartChad',      rep: 7325 },
  { rank: 4, name: 'LiquidityLarry', rep: 6040 },
];

/* ─── Local leaderboard — 8 fake NPC entries, no backend/real players.
   Separate dataset from FAME_LEADERBOARD (that one stays a 4-row Hall of
   Fame preview); this one is the full panel + the player's own row. ─── */
const LEADERBOARD_NPCS = [
  { name: 'WhaleGhost',     rep: 9420 },
  { name: 'AlphaAisha',     rep: 8110 },
  { name: 'ChartChad',      rep: 7325 },
  { name: 'LiquidityLarry', rep: 6040 },
  { name: 'MoonboyNPC',     rep: 4870 },
  { name: 'BagHolderBen',   rep: 3215 },
  { name: 'RugSlayerNPC',   rep: 2150 },
  { name: 'PumpGoblin',     rep: 980 },
];

const LEADERBOARD_TABS = ['Daily', 'Weekly', 'All Time'] as const;
type LeaderboardTab = (typeof LEADERBOARD_TABS)[number];

/* ─── Hall of Fame statue flavor — keyed by rank, not by identity, so it
   reads naturally whether the #1 spot is an NPC or the player (req. 12:
   no real users, nothing here is tied to a specific person). ─── */
const STATUE_RANK_FLAVOR: Record<number, { title: string; flavor: string }> = {
  1: { title: 'Hall of Fame Legend', flavor: 'Etched in gold for all of RugTown to remember.' },
  2: { title: 'Silver Standard', flavor: 'A close second, forever recognized.' },
  3: { title: 'Bronze Contender', flavor: 'Third place, but never forgotten.' },
};

/* ─── NPC dialogue — 3 flavor lines per citizen, no backend/AI ─── */
const NPC_DIALOGUE: Record<string, string[]> = {
  JeetBot:        ["I bought the top again.", "Sold the bottom last week.", "Red candles don't scare me... much."],
  PumpGoblin:     ["Meme Market is heating up.", "I can smell a pump coming.", "Buy first, ask questions later."],
  LiquidityLarry: ["Liquidity looks healthy today.", "Slippage is under control.", "Pools are looking deep tonight."],
  AlphaAisha:     ["Real alpha is patience.", "The best calls are quiet ones.", "Don't chase, let it come to you."],
  ChartChad:      ["That candle looks suspicious.", "This pattern never lies.", "Resistance is just a suggestion."],
  BagHolderBen:   ["I'm not selling until zero.", "Diamond hands, paper plans.", "It'll come back. It always does."],
  WhaleGhost:     ["Big wallets move quietly.", "I've seen things in the mempool.", "Watch the wallets, not the charts."],
  RugSlayerNPC:   ["Trust no dev.", "Always check the liquidity lock.", "If it sounds too good, it's a rug."],
  MoonboyNPC:     ["To the moon, eventually.", "Patience is the real rocket fuel.", "We're still early, probably."],
  DumpDemon:      ["Someone always exits first.", "Every pump needs a dump.", "I sell so you don't have to cry."],
};

/* ─── Inventory: badges + mock items — local-only, no NFT/wallet logic.
   Badge unlock triggers deliberately reuse the same state the quest
   system already watches (rep, fountainClaimed, nearZone, dialogue)
   rather than adding any new tracking to WorldScene or the quests. ─── */
interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
}

const BADGES: Badge[] = [
  { id: 'first-rep',        name: 'First REP',       description: 'Earned your very first REP.',              icon: '⭐' },
  { id: 'fountain-visitor', name: 'Fountain Visitor', description: 'Claimed a reward from the Spawn Fountain.', icon: '⛲' },
  { id: 'market-scout',     name: 'Market Scout',     description: 'Scouted out the Meme Market.',              icon: '🛒' },
  { id: 'npc-talker',       name: 'NPC Talker',       description: 'Talked to a citizen of RugTown.',           icon: '💬' },
  { id: 'whale-watcher',    name: 'Whale Watcher',    description: 'Kept an eye on Whale Tower.',                icon: '🐳' },
  { id: 'treasure-finder',  name: 'Treasure Finder',  description: 'Found a hidden chest during a Treasure Hunt event.', icon: '🗝️' },
  { id: 'whale-watcher-plus', name: 'Whale Watcher+', description: 'Inspected a live Whale Alert event.', icon: '🐋' },
];

interface MockItem {
  id: string;
  name: string;
  description: string;
  icon: string;
}

const MOCK_ITEMS: MockItem[] = [
  { id: 'city-pass',      name: 'City Pass',      description: 'Grants no real privileges. Looks official though.',    icon: '🪪' },
  { id: 'degen-notebook', name: 'Degen Notebook', description: 'Filled with half-finished alpha and worse spelling.', icon: '📓' },
  { id: 'empty-wallet',   name: 'Empty Wallet',   description: 'Technically still a wallet.',                          icon: '👛' },
];

const INVENTORY_TABS = ['Items', 'Badges'] as const;
type InventoryTab = (typeof INVENTORY_TABS)[number];

/* ─── District progression — local-only. Every unlock condition reuses
   state already tracked for quests/badges; nothing new is requested
   from WorldScene, and no movement is blocked. ─── */
interface District {
  id: string;
  name: string;
  description: string;
  requirement: string;
}

const DISTRICTS: District[] = [
  {
    id: 'spawn-plaza',
    name: 'Spawn Plaza',
    description: 'The fountain square where every degen starts their journey.',
    requirement: 'Unlocked by default',
  },
  {
    id: 'meme-market',
    name: 'Meme Market',
    description: 'Stalls trading the latest meme tokens.',
    requirement: 'Claim REP from the Spawn Fountain',
  },
  {
    id: 'hall-of-fame',
    name: 'Hall of Fame',
    description: "A monument to RugTown's top degens.",
    requirement: 'Visit Meme Market',
  },
  {
    id: 'whale-tower',
    name: 'Whale Tower',
    description: 'A watchtower for tracking large wallet movements.',
    requirement: 'Reach 20 REP',
  },
  {
    id: 'alpha-lounge',
    name: 'Alpha Lounge',
    description: 'An exclusive lounge for alpha calls and private chat.',
    requirement: 'Talk to any NPC',
  },
  {
    id: 'rug-alley',
    name: 'Rug Alley',
    description: 'A shadier corner of town — watch your wallet.',
    requirement: 'Check Whale Tower',
  },
  {
    id: 'holder-vault',
    name: 'Holder Vault',
    description: 'A Gold-tier-only vault preview.',
    requirement: 'Holder tier must be Gold',
  },
];

/** Districts that line up with a real WorldObject get a minimap highlight
 *  when unlocked (req. 5) — Rug Alley and Holder Vault aren't registered
 *  landmarks, so they simply don't get one. */
const WORLD_OBJECT_TO_DISTRICT: Record<string, string> = {
  fountain: 'spawn-plaza',
  market:   'meme-market',
  fame:     'hall-of-fame',
  whale:    'whale-tower',
  alpha:    'alpha-lounge',
};

/* ─── Player emotes — local-only. Each one shows a speech bubble above
   the player, plays a brief pop animation, and logs to chat. ─── */
interface Emote {
  id: string;
  label: string;
  icon: string;
}

const EMOTES: Emote[] = [
  { id: 'gm',            label: 'GM',            icon: '☀️' },
  { id: 'wave',          label: 'Wave',          icon: '👋' },
  { id: 'laugh',         label: 'Laugh',         icon: '😂' },
  { id: 'bullish',       label: 'Bullish',       icon: '🚀' },
  { id: 'rug-alert',     label: 'Rug Alert',     icon: '⚠️' },
  { id: 'dance',         label: 'Dance',         icon: '💃' },
  { id: 'point',         label: 'Point',         icon: '👉' },
  { id: 'diamond-hands', label: 'Diamond Hands', icon: '💎' },
];

/** Number keys 1–4 in-world (Phase 6). */
const QUICK_EMOTES: Record<string, Emote> = {
  wave:      { id: 'wave',      label: 'Wave',      icon: '👋' },
  laugh:     { id: 'laugh',     label: 'Laugh',     icon: '😂' },
  bullish:   { id: 'bullish',   label: 'Bullish',   icon: '🚀' },
  'rug-alert': { id: 'rug-alert', label: 'Rug Alert', icon: '⚠️' },
};

const EMOTE_BUBBLE_DURATION = 2500; // ms

/* ─── Starter quests — local-only progress tracking, no backend.
   Each quest's completion trigger reuses state GamePage already tracks
   for other features (fountain claim, zone proximity, NPC dialogue) —
   no new zones or WorldObjects entries needed. ─── */
type QuestStatus = 'in-progress' | 'ready' | 'claimed';

interface Quest {
  id: string;
  title: string;
  description: string;
  reward: number;
}

const QUESTS: Quest[] = [
  {
    id: 'fountain-claim',
    title: 'Claim REP from Spawn Fountain',
    description: 'Visit the fountain and claim your daily REP reward.',
    reward: 10,
  },
  {
    id: 'visit-market',
    title: 'Visit Meme Market',
    description: 'Head over to the Meme Market and see what tokens are trending.',
    reward: 5,
  },
  {
    id: 'talk-npc',
    title: 'Talk to any NPC',
    description: 'Find a citizen of RugTown and press E to talk.',
    reward: 5,
  },
  {
    id: 'check-whale',
    title: 'Check Whale Tower',
    description: 'Visit Whale Tower and keep an eye out for big wallets.',
    reward: 5,
  },
];

/* ─── RugTown Citizens chat activity — local-only, no backend/AI.
   Separate from the per-citizen ambient speech bubbles WorldScene already
   forwards into chat (talking to themselves / reacting to events): this
   timer covers the other ways citizens keep the chat panel feeling alive
   — mentioning a nearby district, replying to another named citizen, or
   welcoming the player. Every line is posted with kind: 'npc', which the
   chat log always renders with a "[NPC]" tag — never presented as a real
   player, per the honesty rule. ─── */
const NPC_CHAT_ACTIVITY_MIN_GAP = 9000;  // ms
const NPC_CHAT_ACTIVITY_MAX_GAP = 19000; // ms

const NPC_DISTRICT_LINES: ((district: string) => string)[] = [
  (d) => `Anyone been to ${d} lately?`,
  (d) => `${d} is looking busy today`,
  (d) => `Heading toward ${d}, catch you later`,
  (d) => `Heard something's happening near ${d}`,
  (d) => `${d} never sleeps, does it`,
  (d) => `I keep ending up back at ${d}`,
];

const NPC_REPLY_LINES = [
  'Real talk.',
  "Couldn't agree more.",
  'Hah, classic.',
  'Not sure about that one, but okay.',
  'Same energy.',
  'Lol, fair point.',
  'I was just thinking that.',
  'Careful saying that out loud.',
  'Based take, honestly.',
  'You always say that.',
];

const NPC_WELCOME_LINES: ((name: string) => string)[] = [
  (name) => `Welcome to RugTown, ${name}.`,
  (name) => `New face in town — hey ${name}.`,
  (name) => `GM ${name}, watch your step around here.`,
  (name) => `${name} just walked in, don't mind us.`,
  (name) => `Don't get rugged on your first day, ${name}.`,
];

/* ─── RugTown Citizens reacting to live Meme Market data — local-only,
   read-only. Reuses the exact same fetchTrendingSolanaTokens() service
   (and its 12s cache) the Market panel itself uses — no separate fetch
   path, no new network surface. Every line is built from the real
   symbol/percent/volume/liquidity of a real trending token; nothing
   here is invented. No wallet, no trading, no swaps — citizens only
   ever talk about the market, never act on it. ─── */
const MARKET_REACTION_MIN_GAP = 20000; // ms
const MARKET_REACTION_MAX_GAP = 40000; // ms
const MARKET_PUMP_THRESHOLD = 15;       // % — strong enough to sound excited (req. 7)
const MARKET_DUMP_THRESHOLD = -15;      // % — strong enough to sound worried (req. 8)
const MARKET_HIGH_VOLUME_USD = 400_000; // 24h volume citizens consider "crazy" (req. 9)
const MARKET_THIN_LIQUIDITY_USD = 20_000; // liquidity citizens consider "thin" (req. 9)

function roundPct(n: number): number {
  return Math.round(n);
}

/** Builds one natural-sounding chat line from a real trending token's
 *  real stats, or null if the token has no usable price data at all.
 *  Picks one applicable "mood" at random rather than always reaching
 *  for the most dramatic one, so the chat doesn't feel like a single
 *  repeating alert bot (req. 10). */
function buildMarketReactionLine(token: MarketToken): string | null {
  const symbol = `$${token.symbol}`;
  const { m5, h1, h24 } = token.priceChange;
  const volume = token.volume24h;
  const liquidity = token.liquidityUsd;

  const candidates: string[] = [];

  const pumps = [
    { window: '5m', value: m5 },
    { window: '1h', value: h1 },
    { window: '24h', value: h24 },
  ].filter((w): w is { window: string; value: number } => w.value !== null && w.value >= MARKET_PUMP_THRESHOLD);
  if (pumps.length > 0) {
    const best = pumps.reduce((a, b) => (b.value > a.value ? b : a));
    candidates.push(
      `${symbol} is pumping +${roundPct(best.value)}% on the ${best.window}!`,
      `${symbol} just ripped +${roundPct(best.value)}%, let's go!`,
      `Everyone's watching ${symbol} after that +${roundPct(best.value)}% move.`,
      `${symbol} is on fire right now, +${roundPct(best.value)}%.`,
    );
  }

  const dumps = [
    { window: '5m', value: m5 },
    { window: '1h', value: h1 },
    { window: '24h', value: h24 },
  ].filter((w): w is { window: string; value: number } => w.value !== null && w.value <= MARKET_DUMP_THRESHOLD);
  if (dumps.length > 0) {
    const worst = dumps.reduce((a, b) => (b.value < a.value ? b : a));
    candidates.push(
      `${symbol} is dumping ${roundPct(worst.value)}% on the ${worst.window}... careful.`,
      `Ouch, ${symbol} is down ${roundPct(worst.value)}%. Rough.`,
      `${symbol} is bleeding right now, ${roundPct(worst.value)}%.`,
      `Not looking good for ${symbol} holders, ${roundPct(worst.value)}%.`,
    );
  }

  if (volume !== null && volume >= MARKET_HIGH_VOLUME_USD) {
    candidates.push(
      `${symbol} volume looks crazy right now.`,
      `A lot of eyes on ${symbol} today, volume is wild.`,
      `${symbol} is getting traded heavy.`,
    );
  }

  if (liquidity !== null && liquidity < MARKET_THIN_LIQUIDITY_USD) {
    candidates.push(
      `Liquidity on ${symbol} is thin. Be careful out there.`,
      `${symbol} liquidity looks light, slippage city.`,
    );
  }

  // Nothing dramatic — still occasionally worth a mention so the chat
  // feels like citizens are genuinely watching the board, not just
  // sounding alarms (req. 10).
  if (candidates.length === 0 && h24 !== null) {
    candidates.push(
      `${symbol} is sitting at ${h24 >= 0 ? '+' : ''}${roundPct(h24)}% today.`,
      `Keeping an eye on ${symbol}.`,
      `${symbol} chart looks interesting right now.`,
    );
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/* ─── Mock Holder tiers — local simulation only, no wallet/Solana calls.
   Toggling a tier just changes the REP multiplier applied to fountain
   and quest rewards. Clearly a devnet/mock preview, not real holdings. ─── */
type HolderTier = 'None' | 'Bronze' | 'Silver' | 'Gold';

const HOLDER_TIERS: { tier: HolderTier; multiplier: number }[] = [
  { tier: 'None',   multiplier: 1 },
  { tier: 'Bronze', multiplier: 1.2 },
  { tier: 'Silver', multiplier: 1.5 },
  { tier: 'Gold',   multiplier: 2 },
];

interface GamePageProps {
  /** Name chosen on the landing page's guest-entry screen */
  playerName?: string;
  /** Ignored: player appearance is the canonical locked appearance. */
  appearance?: CharacterAppearanceV1;
  /** Signed-in user's email, or null for guests.  Shown in Settings. */
  userEmail?: string | null;
  /** Supabase user id — null for guests. Enables profile sync. */
  userId?: string | null;
  /** REP loaded from profiles.rep on login; 0 for guests/new users. */
  initialRep?: number;
  /** Badge IDs already earned, loaded from player_badges on login. */
  initialBadgeIds?: string[];
  /** Item IDs already in player_inventory on login; used to skip re-saving defaults. */
  initialOwnedItemIds?: string[];
  /** District IDs already unlocked, loaded from district_unlocks on login. */
  initialDistrictIds?: string[];
  /** Restored world position after browser refresh (from RugTownSessionStore). */
  initialPosition?: { x: number; y: number } | null;
  /** Called by the Settings sign-out button; only rendered when provided. */
  onLogout?: () => void;
  walletAddress?: string | null;
}

/* ─── Component ─── */
export function GamePage({ playerName, appearance, userEmail, userId, initialRep, initialBadgeIds, initialOwnedItemIds, initialDistrictIds, initialPosition = null, onLogout, walletAddress = null }: GamePageProps) {
  const mountRef   = useRef<HTMLDivElement>(null);
  const gameRef    = useRef<RugTownGame | null>(null);
  const sceneRef   = useRef<WorldScene | null>(null);
  /** Frozen at mount — Phaser boots once; refresh restore uses this spawn. */
  const initialPositionRef = useRef(initialPosition);

  const [ready,  setReady]  = useState(false);
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 0.85 });
  /** Phase 10B — show floating recenter when camera has left follow of the player. */
  const [camNeedsRecenter, setCamNeedsRecenter] = useState(false);
  const [worldSize, setWorldSize] = useState({ w: 3840, h: 2160 });
  const [activeAction, setActiveAction] = useState<string | null>(null);

  /* ── RugTown Citizens population — randomized per session by WorldScene
     (40-60), published once via the registry. Honesty rule: these are
     NPCs, never presented as real players. ── */
  const [npcCount, setNpcCount] = useState(0);
  const [npcNames, setNpcNames] = useState<string[]>([]);

  /* ── Realtime Presence — live online player count ──────────────
     null means "not yet connected / Supabase not configured".
     Shows '—' in the HUD until first sync arrives. ── */
  const [onlineCount, setOnlineCount] = useState<number | null>(null);
  const [presenceFailed, setPresenceFailed] = useState(false);
  /* Other online players from presence — excludes self. Populated on every
     presence sync event so the leaderboard reflects the live city. */
  const [onlinePlayers, setOnlinePlayers] = useState<PresencePayload[]>([]);
  const onlinePlayersRef = useRef<PresencePayload[]>([]);
  /* Visible realtime connection state: Connecting → Online, or Offline on
     failure/timeout. 'offline' immediately when Supabase isn't configured. */
  const [connState, setConnState] = useState<ConnState>(
    isSupabaseConfigured ? 'connecting' : 'offline',
  );

  /* Stable per-session presence id: Supabase uid if logged in, else
     a random guest token that lasts the lifetime of the GamePage. */
  const presenceIdRef = useRef<string>(
    userId ?? `guest_${Math.random().toString(36).slice(2, 10)}`
  );

  useEffect(() => {
    if (userId) presenceIdRef.current = userId;
  }, [userId]);
  /* Latest-value refs for the presence broadcast closure — avoids stale
     state captures inside the 150ms setInterval. */
  const repRef        = useRef(initialRep ?? 0);
  const holderTierRef = useRef<string>('None');
  const playerNameRef = useRef(playerName || 'DegenExplorer');
  const appearanceRef = useRef<CharacterAppearanceV1>(getCanonicalPlayerAppearance());
  // Holds the active Realtime channel so sendChatMessage / triggerEmote
  // can broadcast without needing to reach into the presence useEffect's closure.
  const cityChannelRef = useRef<ReturnType<typeof createCityChannel>>(null);
  // True only after channel.subscribe() resolves to SUBSCRIBED — guards
  // sendChatMessage/triggerEmote from attempting a broadcast before ready.
  const channelSubscribedRef = useRef(false);
  // Dedup set for received emote broadcasts — key: `${senderId}:${timestamp}`
  const receivedEmoteKeysRef = useRef<Set<string>>(new Set());
  // Dedup set for received chat broadcasts — keyed by the message's unique id.
  const receivedChatIdsRef = useRef<Set<string>>(new Set());

  /* ── Interaction zones ── */
  const [nearZone, setNearZone] = useState<NearZone | null>(null);
  const [nearDoor, setNearDoor] = useState<NearDoor | null>(null);
  const [activeInteract, setActiveInteract] = useState<{
    kind: string;
    id: string;
    name: string;
    desktopPrompt: string;
    mobileLabel: string;
    access: string | null;
  } | null>(null);
  const [nearTownCrier, setNearTownCrier] = useState(false);
  const [interiorState, setInteriorState] = useState<InteriorRegistryState>({ active: false, buildingId: null, displayName: null });
  const [interiorPrompt, setInteriorPrompt] = useState<InteriorPromptState | null>(null);
  const [modalZone, setModalZone] = useState<string | null>(null);
  const [modalClosing, setModalClosing] = useState(false);
  const [statusModal, setStatusModal] = useState<{ title: string; text: string; mode: 'locked' | 'coming_soon' | 'info' } | null>(null);
  const [statusModalClosing, setStatusModalClosing] = useState(false);
  const [rep, setRep] = useState(() => initialRep ?? loadProgress().rep);
  const [fountainClaimed, setFountainClaimed] = useState(false);
  const [rewardFlash, setRewardFlash] = useState(0);

  /* ── First-minute onboarding ── */
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [idleHintVisible, setIdleHintVisible] = useState(false);

  /* ── NPC dialogue ── */
  const [nearNpc, setNearNpc] = useState<NearNpc | null>(null);
  const [dialogue, setDialogue] = useState<{ npcName: string; line: string } | null>(null);
  const [dialogueClosing, setDialogueClosing] = useState(false);

  /* ── Event HUD (Phase 2 Event Engine) — read-only from the registry,
     WorldScene/EventManager own all the actual lifecycle state. ── */
  const [eventPhase, setEventPhase] = useState<EnginePhase>('idle');
  const [currentEvent, setCurrentEvent] = useState<RegistryCurrentEvent | null>(null);
  const [eventTimeRemaining, setEventTimeRemaining] = useState(0);
  const lastEventChatKeyRef = useRef<string | null>(null);
  const lastChainAnnouncedKeyRef = useRef<string | null>(null);

  /* ── Event alert dismissal — the live-event banner can be dismissed without
     stopping the underlying event. Resets automatically whenever the event id
     or phase changes (handled in the useEffect below). The mayor announcement
     is no longer a separate card — it flows through the notification queue. ── */
  const [eventBannerDismissed, setEventBannerDismissed] = useState(false);

  /* ── "Today's Story" log (Phase 4 Event Chain System) — a rolling
     window of the last 5 notable moments (event phase starts + player
     claims). Local-only React state, nothing persisted, nothing sent
     anywhere. ── */
  const [storyLog, setStoryLog] = useState<{ id: number; text: string }[]>([]);
  const storyLogIdRef = useRef(0);
  const pushStoryLog = useCallback((text: string) => {
    setStoryLog(prev => {
      const next = [...prev, { id: ++storyLogIdRef.current, text }];
      return next.length > 5 ? next.slice(next.length - 5) : next;
    });
  }, []);

  /* ── Treasure Hunt chest — read-only from the registry; WorldScene owns
     spawn/despawn/claim-gating, this just mirrors it for the HUD/minimap. ── */
  const [treasureChest, setTreasureChest] = useState<{ wx: number; wy: number } | null>(null);
  const [nearTreasure, setNearTreasure] = useState(false);
  const [treasureClaim, setTreasureClaim] = useState<{ claimId: number; amount: number; label: string } | null>(null);
  const treasureClaimIdRef = useRef(0);

  /* ── Whale Alert marker — same read-only-mirror pattern as the chest
     above; WorldScene owns spawn/despawn/claim-gating. ── */
  const [whaleMarker, setWhaleMarker] = useState<{ wx: number; wy: number } | null>(null);
  const [nearWhale, setNearWhale] = useState(false);
  const [whaleAlert, setWhaleAlert] = useState<{
    wallet: string; buySol: number; tokenSymbol: string; riskLevel: string; rewardLabel: string;
  } | null>(null);
  const [whaleAlertClosing, setWhaleAlertClosing] = useState(false);
  const [whaleClaim, setWhaleClaim] = useState<{ claimId: number; amount: number; label: string } | null>(null);
  const whaleClaimIdRef = useRef(0);

  /* ── Phase 3 mission tracker + Phase 5 progress HUD ── */
  const [missionState, setMissionState] = useState<MissionRegistryState>(EMPTY_MISSION_STATE);
  /* ── Phase 2: hidden quests — server-authoritative discover/complete + Mission HQ panel ── */
  const [hiddenQuestState, setHiddenQuestState] = useState<{
    discoveredIds: string[]; completedIds: string[]; discoveredCount: number; completedCount: number; totalCount: number;
  }>({ discoveredIds: [], completedIds: [], discoveredCount: 0, completedCount: 0, totalCount: 0 });
  const processedHiddenQuestDiscoveriesRef = useRef<Set<string>>(new Set());
  const processedHiddenQuestCompletionsRef = useRef<Set<string>>(new Set());
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [expandedMapOpen, setExpandedMapOpen] = useState(false);
  const [mapFilters] = useState(() => loadMapFilters());
  const [currentDistrict, setCurrentDistrict] = useState('');
  /** Missions already rewarded (seeded from save so REP is granted once ever). */
  const rewardedMissionsRef = useRef<Set<string>>(new Set(loadProgress().completedMissions));
  const spawnPosRef = useRef<{ x: number; y: number } | null>(null);
  const onboardingDoneRef = useRef(false);

  /* ── Hall of Fame statues — permanent fixture, not event-driven. No
     claim/reward (unlike the chest/whale), so there's no *Claim state —
     just the proximity mirror and the inspect modal. ── */
  const [nearStatue, setNearStatue] = useState<{ rank: number; name: string } | null>(null);
  const [statueModal, setStatueModal] = useState<{ rank: number; name: string; rep: number; isPlayer: boolean } | null>(null);
  const [statueModalClosing, setStatueModalClosing] = useState(false);

  /* ── Remote player profile card ── */
  const [remoteProfile, setRemoteProfile] = useState<SocialPlayerSummary | null>(null);
  const [remoteProfileClosing, setRemoteProfileClosing] = useState(false);
  const [remoteOfflineNotice, setRemoteOfflineNotice] = useState<string | null>(null);
  const [dmRecipient, setDmRecipient] = useState<DirectMessageRecipient | null>(null);
  const [dmClosing, setDmClosing] = useState(false);
  const [remoteFriendship, setRemoteFriendship] = useState<FriendshipState | null>(null);
  const [socialHubOpen, setSocialHubOpen] = useState(false);
  const [partyPanelOpen, setPartyPanelOpen] = useState(false);
  const [eventCentreOpen, setEventCentreOpen] = useState(false);
  const [tournamentCentreOpen, setTournamentCentreOpen] = useState(false);
  const [guildPanelOpen, setGuildPanelOpen] = useState(false);
  const [rugtownGuildOpen, setRugtownGuildOpen] = useState(false);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [partyUnread, setPartyUnread] = useState(0);
  const [moderationOpen, setModerationOpen] = useState(false);
  const [reportPlayer, setReportPlayer] = useState<{ playerId: string; username: string } | null>(null);
  const [reportMessageId, setReportMessageId] = useState<string | null>(null);
  const [unreadDmCount, setUnreadDmCount] = useState(0);

  /* ── Phase 10F progression identity ── */
  const [progression, setProgression] = useState<PlayerProgression | null>(null);
  const [levelUpQueue, setLevelUpQueue] = useState<LevelUpNotice[]>([]);
  const [activeLevelUp, setActiveLevelUp] = useState<LevelUpNotice | null>(null);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [rewardCentreOpen, setRewardCentreOpen] = useState(false);
  const [rewardOpsOpen, setRewardOpsOpen] = useState(false);
  const [achievementCentreOpen, setAchievementCentreOpen] = useState(false);
  const [titleLockerOpen, setTitleLockerOpen] = useState(false);
  const [seasonPassOpen, setSeasonPassOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const progressionRef = useRef<PlayerProgression | null>(null);

  /* ── Local city chat (frontend-only, no backend) ── */
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatLogRef   = useRef<HTMLDivElement>(null);
  const chatMsgIdRef = useRef(0);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const isChatOpen = activeAction === 'Chat';

  /* ── Level progression system — local-only, no backend ── */
  const [currentLevel, setCurrentLevel] = useState(() => {
    const saved = localStorage.getItem('rugtown:currentLevel');
    return saved ? Math.max(1, parseInt(saved, 10)) : 1;
  });
  const currentLevelRef    = useRef(currentLevel);
  const levelCompletedRef  = useRef(0);
  const currentLevelDef    = LEVEL_DEFINITIONS.find(l => l.id === currentLevel) ?? null;

  /* ── Quests (frontend-only, no backend) ── */
  const announcedQuestsRef = useRef<Set<string>>(new Set());
  const [questStatus, setQuestStatus] = useState<Record<string, QuestStatus>>(
    () => Object.fromEntries(QUESTS.map(q => [q.id, 'in-progress' as QuestStatus]))
  );
  const isQuestsOpen = activeAction === 'Quests';

  /* ── Notifications — every system routes through the ONE global queue
     (src/lib/notificationQueue.ts): one visible at a time, FIFO, ~15s gap,
     priority for the big beats, X advances immediately. showToast() is kept
     as the generic system-notification entry point so existing callers just
     work; the important beats (treasure/whale/mayor) enqueue with a kind +
     high priority directly. ── */
  const showToast = useCallback((text: string) => {
    notificationQueue.push({ kind: 'system', text });
  }, []);

  /* Init progression service once per GamePage mount */
  useEffect(() => {
    const pid = presenceIdRef.current;
    const isGuest = !userId;
    const prog = progressionService.init(pid, isGuest, {
      seedRep: initialRep ?? loadProgress().rep,
    });
    progressionRef.current = prog;
    setProgression({ ...prog });
    // Align React REP with migrated progression (never lower seed without reason)
    setRep((r) => Math.max(r, prog.rep));

    const unsub = progressionService.subscribe((next, meta) => {
      progressionRef.current = next;
      setProgression({ ...next, achievementProgress: { ...next.achievementProgress } });
      setRep(next.rep);
      if (meta?.levelUps?.length) {
        setLevelUpQueue((q) => [...q, ...meta.levelUps!]);
      }
      sceneRef.current?.game?.registry.set('progressionDebug', progressionService.snapshot());
      // Feeds MissionSystem.setPlayerLevel() (level-gated mission unlocks) and
      // HiddenQuestDirector's LEVEL/COMPOUND triggers via WorldScene's registry listeners.
      sceneRef.current?.game?.registry.set('playerLevel', next.level);
    });

    sceneRef.current?.game?.registry.set('progressionDebug', progressionService.snapshot());
    sceneRef.current?.game?.registry.set('playerLevel', prog.level);
    if (import.meta.env.DEV) {
      (window as unknown as { __rugtownProgression?: typeof progressionService }).__rugtownProgression =
        progressionService;
      (window as unknown as { __rugtownRewards?: typeof rewardService }).__rugtownRewards = rewardService;
    }

    void rewardService.initForUser({
      userId: userId ?? null,
      isGuest: !userId,
      guestIdentity: presenceIdRef.current,
    }).then(() => {
      // Authenticated game session (guests continue local-only, no session).
      if (userId) {
        void rewardService.startSession();
        // Phase 10I: hydrate server achievements / titles / season pass.
        void achievementService.initForAuthenticatedUser(userId);
        // Phase 10J: friends, DMs, blocks, presence heartbeat.
        void socialService.initForAuthenticatedUser(userId).then(() => {
          setUnreadDmCount(socialService.getUnreadDmCount());
        });
        void partyService.initForAuthenticatedUser(userId).then(() => {
          setPartyUnread(partyService.getUnreadChatCount());
        });
        void characterService.initForAuthenticatedUser(userId);
        // Phase 2: hydrate the server-authoritative streak so
        // HiddenQuestDirector's STREAK/COMPOUND triggers have real data.
        void getMyStreak().then((streak) => {
          if (streak) sceneRef.current?.game?.registry.set('playerStreak', streak.currentStreak);
        });
        // Phase 2: bounded time-in-game reward. Server enforces the real
        // cooldown (5 min) and daily cap (6/day) regardless of this
        // interval's cadence -- only fires while the tab is actually visible
        // so a backgrounded/idle tab earns nothing (brief: "reward active
        // participation rather than an idle tab").
        const heartbeatInterval = setInterval(() => {
          if (document.visibilityState === 'visible') void recordActivityHeartbeat();
        }, 3 * 60 * 1000);
        heartbeatIntervalRef.current = heartbeatInterval;
      } else {
        socialService.clear();
        partyService.clear();
        characterService.clear();
        setUnreadDmCount(0);
        setPartyUnread(0);
      }
    });

    const unsubSocial = socialService.subscribe(() => {
      setUnreadDmCount(socialService.getUnreadDmCount());
    });
    const unsubParty = partyService.subscribe(() => {
      setPartyUnread(partyService.getUnreadChatCount());
    });

    return () => {
      unsub();
      unsubSocial();
      unsubParty();
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      // Release Realtime subscriptions + end the authenticated session.
      void rewardService.endSession();
      rewardService.teardown();
      achievementService.teardown();
      socialService.clear();
      partyService.clear();
      characterService.clear();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __rugtownProgression?: unknown }).__rugtownProgression;
        delete (window as unknown as { __rugtownRewards?: unknown }).__rugtownRewards;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeLevelUp || levelUpQueue.length === 0) return;
    const [next, ...rest] = levelUpQueue;
    setActiveLevelUp(next);
    setLevelUpQueue(rest);
    soundManager.play('reward');
    notificationQueue.push({
      kind: 'level',
      title: 'Level Up',
      text: `You reached level ${next.toLevel}`,
      icon: '◆',
      priority: 'normal',
      duration: 5000,
    });
  }, [activeLevelUp, levelUpQueue]);

  /* ── Mock Holder tier ── */
  const [holderTier, setHolderTier] = useState<HolderTier>('None');
  const [tierJustChanged, setTierJustChanged] = useState(false);
  const isHolderOpen = activeAction === 'Holder';

  /* ── "Today's Story" log panel (Phase 4 Event Chain System) ── */
  const isStoryOpen = activeAction === 'Story';

  const holderMultiplier = HOLDER_TIERS.find(t => t.tier === holderTier)?.multiplier ?? 1;
  const applyHolderMultiplier = useCallback(
    (base: number) => Math.round(base * holderMultiplier),
    [holderMultiplier]
  );

  /* ── Local leaderboard — recomputed from current REP, so the player's
     row always sorts to its correct position as REP changes. Tabs are
     cosmetic for now (req. 7) — all three show the same local data. ── */
  const isLeaderboardOpen = activeAction === 'Leaderboard';
  const isMissionHQOpen = activeAction === 'Mission HQ';
  const [leaderboardTab, setLeaderboardTab] = useState<LeaderboardTab>('Daily');
  const leaderboardRows = [
    ...LEADERBOARD_NPCS.map(e => ({ name: e.name, rep: e.rep, isPlayer: false, isOnline: false })),
    { name: playerName || 'DegenExplorer', rep, isPlayer: true, isOnline: true },
    ...onlinePlayers.map(p => ({ name: p.username, rep: p.rep, isPlayer: false, isOnline: true })),
  ]
    .sort((a, b) => b.rep - a.rep)
    .map((row, i) => ({ ...row, rank: i + 1 }));

  /* ── Hall of Fame statues — WorldScene renders the actual markers near
     the 'fame' landmark, but it has no leaderboard data of its own, so
     GamePage pushes the top 3 rows (same data as the Leaderboard panel
     above) every time they actually change. The ref-based JSON guard
     just avoids redundant Graphics rebuilds on every ~100ms poll tick. ── */
  const hallOfFameTop3JsonRef = useRef('');
  useEffect(() => {
    if (!ready) return;
    const top3 = leaderboardRows.slice(0, 3).map(r => ({ rank: r.rank, name: r.name, rep: r.rep, isPlayer: r.isPlayer }));
    const json = JSON.stringify(top3);
    if (json === hallOfFameTop3JsonRef.current) return;
    hallOfFameTop3JsonRef.current = json;
    sceneRef.current?.setHallOfFameStatues(top3);
  }, [ready, leaderboardRows]);

  /* ── Local sound system — WebAudio-only. Not muted by default (the
     real gate is `soundUnlocked` below — the AudioContext itself can't
     play anything before a user gesture, so there's nothing to
     accidentally autoplay), the first pointerdown/keydown anywhere
     unlocks it. Initial values read straight from soundManager so this
     never drifts out of sync with its actual defaults. ── */
  const isSettingsOpen = activeAction === 'Settings';
  const [muted, setMutedState] = useState(() => soundManager.isMuted());
  const [soundUnlocked, setSoundUnlocked] = useState(() => soundManager.isUnlocked());
  const [musicVol, setMusicVol] = useState(soundManager.getVolume('music'));
  const [effectsVol, setEffectsVol] = useState(soundManager.getVolume('effects'));

  /* ── Settings panel: fullscreen + collision debug ── */
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [collisionDebugOn, setCollisionDebugOn] = useState(false);
  const [assetBoundsDebugOn, setAssetBoundsDebugOn] = useState(false);
  const [assetAnchorsDebugOn, setAssetAnchorsDebugOn] = useState(false);
  const [assetRoadDebugOn, setAssetRoadDebugOn] = useState(false);
  const [assetPlayerDepthDebugOn, setAssetPlayerDepthDebugOn] = useState(false);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    // Both return Promises that can reject (e.g. denied, or no longer in
    // an active gesture) — swallow that instead of leaving an unhandled
    // rejection in the console.
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  const toggleCollisionDebug = useCallback(() => {
    sceneRef.current?.setCollisionDebugVisible(!collisionDebugOn);
  }, [collisionDebugOn]);

  const toggleAssetBoundsDebug = useCallback(() => {
    sceneRef.current?.setAssetBoundsDebugVisible(!assetBoundsDebugOn);
  }, [assetBoundsDebugOn]);

  const toggleAssetAnchorsDebug = useCallback(() => {
    sceneRef.current?.setAssetAnchorsDebugVisible(!assetAnchorsDebugOn);
  }, [assetAnchorsDebugOn]);

  const toggleAssetRoadDebug = useCallback(() => {
    sceneRef.current?.setAssetRoadClearanceDebugVisible(!assetRoadDebugOn);
  }, [assetRoadDebugOn]);

  const toggleAssetPlayerDepthDebug = useCallback(() => {
    sceneRef.current?.setAssetPlayerDepthDebugVisible(!assetPlayerDepthDebugOn);
  }, [assetPlayerDepthDebugOn]);

  useEffect(() => {
    const unlock = () => {
      soundManager.unlock();
      setSoundUnlocked(true);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const toggleMuted = useCallback(() => {
    setMutedState(prev => {
      const next = !prev;
      soundManager.setMuted(next);
      return next;
    });
  }, []);

  /** Settings panel's "Test Sound" button — also doubles as a reliable
   *  way to unlock audio for anyone who opened Settings before their
   *  first click/tap elsewhere registered (opening the panel is itself
   *  a click, but this guarantees the chime actually plays on it). */
  const playTestSound = useCallback(() => {
    soundManager.unlock();
    setSoundUnlocked(true);
    soundManager.play('reward');
  }, []);

  const handleVolumeChange = useCallback((channel: SoundChannel, value: number) => {
    soundManager.setVolume(channel, value);
    if (channel === 'music') setMusicVol(value);
    else setEffectsVol(value);
  }, []);

  /* ── Music context ──────────────────────────────────────────────
     A live event overrides the ambient city music with the event track;
     leaving the event (any non-live phase) fades back. Standing at the
     Meme Market building optionally pins the market track. SoundManager
     enforces the event > market > ambient priority, so these two effects
     can be declared independently. ── */
  useEffect(() => {
    soundManager.setEventMusic(eventPhase === 'live');
  }, [eventPhase]);

  useEffect(() => {
    soundManager.setMarketMusic(nearZone?.id === 'market');
  }, [nearZone]);

  /* ── Inventory: badges + mock items ── */
  const isInventoryOpen = activeAction === 'Inventory';
  const [inventoryTab, setInventoryTab] = useState<InventoryTab>('Items');
  // Pre-populate with already-earned badges so they don't fire toasts again
  // and any DB insert for them is skipped (idempotent but saves a write).
  const announcedBadgesRef = useRef<Set<string>>(new Set(initialBadgeIds ?? []));
  const [badgeStatus, setBadgeStatus] = useState<Record<string, 'locked' | 'unlocked'>>(
    () => Object.fromEntries(
      BADGES.map(b => [
        b.id,
        (initialBadgeIds ?? []).includes(b.id) ? 'unlocked' as const : 'locked' as const,
      ])
    )
  );

  // Idempotent — safe to call repeatedly, same pattern as markQuestReady.
  // For logged-in users, also persists the badge to player_badges.
  const unlockBadge = useCallback((id: string) => {
    setBadgeStatus(prev => (prev[id] === 'locked' ? { ...prev, [id]: 'unlocked' } : prev));
    if (!announcedBadgesRef.current.has(id)) {
      announcedBadgesRef.current.add(id);
      const badge = BADGES.find(b => b.id === id);
      if (badge) showToast(`🏅 Badge unlocked: ${badge.name}`);
      // Persist for logged-in users — fire-and-forget, guests are skipped.
      if (userId) saveBadge(userId, id).catch(() => {});
    }
  }, [showToast, userId]);

  /* ── District progression ── */
  const isMapOpen = activeAction === 'Map';
  // Pre-populate with already-unlocked districts (loaded from DB) + spawn-plaza
  // (always unlocked) so returning users don't get re-toasted on re-trigger.
  const announcedDistrictsRef = useRef<Set<string>>(
    new Set(['spawn-plaza', ...(initialDistrictIds ?? [])])
  );
  const wasGoldRef = useRef(false);
  const [districtUnlocked, setDistrictUnlocked] = useState<Record<string, boolean>>(
    () => Object.fromEntries(
      DISTRICTS.map(d => [
        d.id,
        d.id === 'spawn-plaza' || (initialDistrictIds ?? []).includes(d.id),
      ])
    )
  );

  // Sticky — once unlocked, stays unlocked (same idempotent pattern as
  // quests/badges). Holder Vault is the one exception, handled below.
  // For logged-in users, persists the unlock to district_unlocks.
  const unlockDistrict = useCallback((id: string) => {
    setDistrictUnlocked(prev => (prev[id] ? prev : { ...prev, [id]: true }));
    if (!announcedDistrictsRef.current.has(id)) {
      announcedDistrictsRef.current.add(id);
      const district = DISTRICTS.find(d => d.id === id);
      if (district) showToast(`🗺️ District unlocked: ${district.name}`);
      // Persist for logged-in users — fire-and-forget, guests are skipped.
      if (userId) saveDistrictUnlock(userId, id).catch(() => {});
    }
  }, [showToast, userId]);

  const setHolderTierAndNotify = useCallback((tier: HolderTier) => {
    if (tier === holderTier) return;
    const mult = HOLDER_TIERS.find(t => t.tier === tier)?.multiplier ?? 1;
    setHolderTier(tier);
    showToast(`Holder tier set to ${tier} (${mult}x REP) — MOCK`);
    setTierJustChanged(true);
    setTimeout(() => setTierJustChanged(false), 900);
  }, [holderTier, showToast]);

  // Marks a quest "ready to claim" the first time its trigger fires.
  // Idempotent — safe to call repeatedly (e.g. walking in/out of a zone).
  const markQuestReady = useCallback((id: string) => {
    setQuestStatus(prev => (prev[id] === 'in-progress' ? { ...prev, [id]: 'ready' } : prev));
    if (!announcedQuestsRef.current.has(id)) {
      announcedQuestsRef.current.add(id);
      const quest = QUESTS.find(q => q.id === id);
      if (quest) showToast(`Quest complete: ${quest.title}`);
      soundManager.play('quest');
    }
  }, [showToast]);

  const claimQuestReward = useCallback((id: string) => {
    // Guard on the actual current status (not just the state updater) so
    // the REP/flash/effect below can never fire twice for the same quest.
    if (questStatus[id] !== 'ready') return;
    const quest = QUESTS.find(q => q.id === id);
    if (!quest) return;
    const amount = applyHolderMultiplier(quest.reward);
    setQuestStatus(prev => ({ ...prev, [id]: 'claimed' }));
    setRep(r => r + amount);
    setRewardFlash(k => k + 1);
    sceneRef.current?.playRewardEffect(`+${amount} REP`);
    soundManager.play('reward');
    progressionService.recordExternalRepGrant({
      amount,
      reason: `Quest ${id}`,
      idempotencyKey: `quest:${id}:claim`,
    });
  }, [questStatus, applyHolderMultiplier]);

  const appendChatMessage = useCallback((sender: string, text: string, kind: ChatMessage['kind']) => {
    setChatMessages(prev => {
      const next = [...prev, { id: ++chatMsgIdRef.current, sender, text, kind }];
      return next.length > 60 ? next.slice(next.length - 60) : next;
    });
  }, []);

  /* ── Level completion — fires when an objective is satisfied.
     Reads currentLevel from a ref (not state) so the callback itself is
     stable and safe to call from stale closures and inline event handlers.
     The levelCompletedRef guard prevents the same level completing twice
     if two triggers fire in the same synchronous pass. ── */
  const completeLevelIfMatches = useCallback((
    type: LevelObjectiveType,
    target?: string | number,
  ) => {
    const lvl = currentLevelRef.current;
    const def = LEVEL_DEFINITIONS.find(l => l.id === lvl);
    if (!def) return;                                         // beyond level 30
    if (def.objectiveType !== type) return;
    if (target !== undefined && def.target !== target) return;
    if (levelCompletedRef.current >= lvl) return;            // already completing

    levelCompletedRef.current  = lvl;
    currentLevelRef.current    = lvl + 1;                    // optimistic for chaining

    setRep(r => r + def.rewardRep);
    setRewardFlash(k => k + 1);
    sceneRef.current?.playRewardEffect(`+${def.rewardRep} REP`);
    soundManager.play('reward');
    showToast(`Level ${lvl} Complete: ${def.title}`);
    appendChatMessage(
      'City Feed',
      `Mission complete: ${def.title} — ${def.unlockText}`,
      'event',
    );
    setCurrentLevel(lvl + 1);
    progressionService.recordExternalRepGrant({
      amount: def.rewardRep,
      reason: `Tutorial level ${lvl}`,
      idempotencyKey: `tutorial_level:${lvl}:rep`,
    });
    progressionService.onTutorialLevelComplete(lvl);
  }, [showToast, appendChatMessage]);

  /* ── Boot Phaser ── */
  useEffect(() => {
    if (!mountRef.current) return;

    // React.StrictMode (dev only) mounts -> cleans up -> mounts this effect
    // again. RugTownGame's onReady fires asynchronously, so the first,
    // already-destroyed instance's callback can resolve after cleanup and
    // clobber the refs below with a torn-down scene. `cancelled` blocks that.
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let game: RugTownGame | null = null;

    let lastCamX = NaN, lastCamY = NaN, lastCamZoom = NaN;
    let lastEventSec = -1;
    // Proximity/marker values are re-created as fresh objects every Phaser
    // frame, so comparing by reference would re-render this huge component
    // 10×/sec whenever the player is near anything. Track a cheap string
    // signature instead and only push into React state when it changes.
    let lastNearZoneSig = '';
    let lastNearNpcSig = '';
    let lastNearStatueSig = '';
    let lastTreasureSig = '';
    let lastWhaleSig = '';

    void import('../game/RugTownGame').then(({ RugTownGame: GameCtor }) => {
      if (cancelled || !mountRef.current) return;

      game = new GameCtor({
      parentId: 'phaser-mount',
      appearance: getCanonicalPlayerAppearance(),
      initialPosition: initialPositionRef.current ?? null,
      assetGallery: new URLSearchParams(window.location.search).get('assetGallery') === '1',
      onReady: (scene: WorldScene) => {
        if (cancelled) return;
        sceneRef.current = scene;
        setReady(true);
        setWorldSize(scene.getWorldSize());

        try {
          if (sessionStorage.getItem('rugtown:panel-character') === '1') {
            sessionStorage.removeItem('rugtown:panel-character');
            scene.reportGameplayEvent({ type: 'PANEL_OPENED', panelId: 'character' });
          }
          if (sessionStorage.getItem('rugtown:appearance-saved') === '1') {
            sessionStorage.removeItem('rugtown:appearance-saved');
            scene.reportGameplayEvent({ type: 'APPEARANCE_SAVED' });
          }
        } catch { /* ignore */ }

        // RugTown Citizens population is randomized per session by
        // WorldScene (createNpcs) and published once — read it here so
        // the HUD/chat-activity simulator never hardcode a fixed count.
        const count = scene.game?.registry?.get('npcCount') ?? 0;
        const names: string[] = scene.game?.registry?.get('npcNames') ?? [];
        setNpcCount(count);
        setNpcNames(names);

        // Initialise the mission zone pulse for the level active at scene start.
        const initDef = LEVEL_DEFINITIONS.find(l => l.id === currentLevelRef.current);
        scene.setActiveMissionZone(
          initDef?.objectiveType === 'visit_zone' ? (initDef.target as string) : null,
        );

        // Phaser-side E press near a zone — open the matching modal.
        // Landmark interactions take priority, so also dismiss any open
        // NPC dialogue rather than stacking both overlays.
        scene.events.on('zone-interact', (zone: NearZone) => {
          if (cancelled) return;
          setDialogueClosing(false);
          setDialogue(null);
          setModalClosing(false);
          setActiveAction(null);
          setWhaleAlertClosing(false);
          setWhaleAlert(null);
          setStatueModalClosing(false);
          setStatueModal(null);

          if (zone.id === 'government') {
            setModalZone(null);
            setRugtownGuildOpen(true);
            void reportGuildGameplayEvent({
              eventType: 'discover_landmark',
              ref: zone.id,
              idempotencyKey: `landmark:${zone.id}:${new Date().toISOString().slice(0, 10)}`,
            });
            soundManager.play('modal');
            return;
          }
          if (zone.id === 'cashback') {
            setModalZone(null);
            setVaultPanelOpen(true);
            void reportGuildGameplayEvent({
              eventType: 'discover_landmark',
              ref: zone.id,
              idempotencyKey: `landmark:${zone.id}:${new Date().toISOString().slice(0, 10)}`,
            });
            soundManager.play('modal');
            return;
          }

          setModalZone(zone.id);
          void reportGuildGameplayEvent({
            eventType: 'discover_landmark',
            ref: zone.id,
            idempotencyKey: `landmark:${zone.id}:${new Date().toISOString().slice(0, 10)}`,
          });
          soundManager.play('modal');
        });

        scene.events.on('door-message', (payload: {
          buildingId: string;
          title: string;
          text: string;
          mode: 'locked' | 'coming_soon';
        }) => {
          if (cancelled) return;
          setDialogueClosing(false);
          setDialogue(null);
          setModalClosing(false);
          setModalZone(null);
          setActiveAction(null);
          setWhaleAlertClosing(false);
          setWhaleAlert(null);
          setStatueModalClosing(false);
          setStatueModal(null);
          setStatusModalClosing(false);
          setStatusModal({
            title: payload.title,
            text: payload.text,
            mode: payload.mode,
          });
          soundManager.play('modal');
        });

        // Phaser-side E press near an NPC — open a dialogue line.
        // WorldScene won't emit this while a landmark zone is active, but
        // clear any (stale) open modal too, just in case of a fast switch.
        scene.events.on('npc-interact', (npc: NearNpc & { personality?: NpcPersonality; districtId?: string }) => {
          if (cancelled) return;
          const districtLines = npc.districtId ? getDistrictDialogueLines(npc.districtId) : [];
          const personalityLines = npc.personality ? NPC_SPEECH_BY_PERSONALITY[npc.personality] : [];
          const namedLines = NPC_DIALOGUE[npc.name];
          const lines = namedLines
            ?? (districtLines.length > 0 ? districtLines : personalityLines);
          if (!lines || lines.length === 0) return;
          setModalClosing(false);
          setModalZone(null);
          setDialogueClosing(false);
          setDialogue({ npcName: npc.name, line: lines[Math.floor(Math.random() * lines.length)] });
          setActiveAction(null); // only one overlay open at a time
          setWhaleAlertClosing(false);
          setWhaleAlert(null);
          setStatueModalClosing(false);
          setStatueModal(null);
          soundManager.play('modal');
        });

        // NPCs occasionally post their ambient speech-bubble line into chat
        scene.events.on('npc-chat', (msg: { name: string; text: string }) => {
          if (cancelled) return;
          appendChatMessage(msg.name, msg.text, 'npc');
        });

        scene.events.on('player-quick-emote', (emoteId: string) => {
          if (cancelled) return;
          const emote = QUICK_EMOTES[emoteId];
          if (emote) triggerEmote(emote);
        });

        // Treasure Hunt chest opened — WorldScene has already destroyed the
        // chest (so a double-claim is impossible) and computed the reward
        // from the live event state. This just records the claim; the
        // actual REP/badge/chat side effects run in the effect below, which
        // always reads fresh playerName/holderMultiplier (this listener is
        // registered once, so it must not read that state directly).
        scene.events.on('treasure-interact', (payload: { rewardAmount: number; rewardLabel: string }) => {
          if (cancelled) return;
          setTreasureClaim({ claimId: ++treasureClaimIdRef.current, amount: payload.rewardAmount, label: payload.rewardLabel });
        });

        // Whale Alert marker inspected — same one-shot-claim guarantee as
        // the treasure chest (WorldScene destroyed the marker before
        // emitting). Opens the Whale Alert modal AND records the claim;
        // the modal is purely a flavor/transparency display, the actual
        // REP/badge/chat side effects run in the effect below so they
        // always read fresh playerName/holderMultiplier.
        scene.events.on('whale-interact', (payload: {
          wallet: string; buySol: number; tokenSymbol: string; riskLevel: string; rewardAmount: number; rewardLabel: string;
        }) => {
          if (cancelled) return;
          setDialogueClosing(false);
          setDialogue(null);
          setModalClosing(false);
          setModalZone(null);
          setActiveAction(null); // only one overlay open at a time
          setWhaleAlertClosing(false);
          setWhaleAlert({
            wallet: payload.wallet,
            buySol: payload.buySol,
            tokenSymbol: payload.tokenSymbol,
            riskLevel: payload.riskLevel,
            rewardLabel: payload.rewardLabel,
          });
          setStatueModalClosing(false);
          setStatueModal(null);
          setWhaleClaim({ claimId: ++whaleClaimIdRef.current, amount: payload.rewardAmount, label: payload.rewardLabel });
          soundManager.play('modal');
        });

        // Town Crier shows up for any event's Announcement phase — purely
        // a chat-message hook here, the character itself is entirely
        // WorldScene-rendered (no proximity prompt/modal, nothing to
        // claim). The bell sound already played in WorldScene at spawn.
        scene.events.on('town-crier-announce', (payload: { title: string }) => {
          if (cancelled) return;
          appendChatMessage('Town Crier', `🔔 Town Crier announces: ${payload.title}`, 'event');
        });

        scene.events.on('town-crier-interact', (payload: { title: string }) => {
          if (cancelled) return;
          setDialogueClosing(false);
          setDialogue({
            npcName: 'Town Crier',
            line: `Hear ye! ${payload.title} is the talk of RugTown today.`,
          });
          setModalClosing(false);
          setModalZone(null);
          setActiveAction(null);
          setWhaleAlertClosing(false);
          setWhaleAlert(null);
          setStatueModalClosing(false);
          setStatueModal(null);
          setStatusModalClosing(false);
          setStatusModal(null);
          soundManager.play('modal');
        });

        scene.events.on('interior-entered', (payload: { buildingId: string; displayName: string }) => {
          if (cancelled) return;
          appendChatMessage('City Feed', `🚪 Entered ${payload.displayName}.`, 'event');
        });

        scene.events.on('interior-feature', (payload: { buildingId: string; title: string; text: string }) => {
          if (cancelled) return;
          setDialogueClosing(false);
          setDialogue(null);
          setModalClosing(false);
          setModalZone(null);
          setActiveAction(null);
          setWhaleAlertClosing(false);
          setWhaleAlert(null);
          setStatueModalClosing(false);
          setStatueModal(null);
          setStatusModalClosing(false);
          setStatusModal({
            title: payload.title,
            text: payload.text,
            mode: 'info',
          });
          soundManager.play('modal');
        });

        // Hall of Fame statue inspected — no claim/reward (statues are a
        // permanent fixture, not a one-shot event pickup), just opens the
        // inspect modal and posts a chat message. Clears every other
        // overlay first, same exclusivity rule as the others above.
        // Remote player clicked / E interact — open the social card
        scene.events.on('remote-player-interact', (payload: SocialPlayerSummary | PresencePayload) => {
          if (cancelled) return;
          const summary: SocialPlayerSummary = 'playerId' in payload
            ? (payload as SocialPlayerSummary)
            : presenceToSocialSummary(payload as PresencePayload);
          // Enrich from presence optional progression fields
          if (!('playerId' in payload)) {
            const p = payload as PresencePayload;
            summary.level = p.level;
            summary.rankLabel = p.rankLabel;
            summary.equippedTitle = p.equippedTitle;
            summary.holderTier = p.holderTier || 'None';
          }
          progressionService.onPlayerInteracted(summary.playerId);
          void rewardService.reportObjective({ objectiveType: 'meet_player', ref: summary.playerId });
          if (userId && summary.playerId !== userId) {
            const day = new Date().toISOString().slice(0, 10);
            void reportGuildGameplayEvent({
              eventType: 'meet_player',
              counterpartId: summary.playerId,
              idempotencyKey: `social:${summary.playerId}:${day}`,
            });
          }
          if (rewardService.isServerAuthoritative()) {
            void rewardService.awardGameplay({
              sourceType: 'player_interact',
              sourceId: summary.playerId,
              idempotencyKey: `social:player:${summary.playerId}:interact`,
            });
          }
          setRemoteOfflineNotice(null);
          setRemoteProfile(summary);
          setRemoteProfileClosing(false);
        });
        scene.events.on('remote-player-gone', (payload: { id: string }) => {
          if (cancelled) return;
          setRemoteProfile((prev) => {
            if (!prev || prev.playerId !== payload.id) return prev;
            setRemoteOfflineNotice('Player is no longer online');
            return { ...prev, online: false };
          });
          setDmRecipient((prev) => (prev?.playerId === payload.id ? null : prev));
        });
        scene.events.on('district-entered', (payload: { districtId: string; name: string }) => {
          if (cancelled) return;
          if (progressionService.discoverDistrict(payload.districtId, {
            skipAwards: rewardService.isServerAuthoritative(),
          })) {
            const district = WORLD_DISTRICTS.find((d) => d.id === payload.districtId);
            notificationQueue.push({
              kind: 'district',
              icon: '◇',
              title: 'District Discovered',
              text: district?.name ?? payload.name,
              duration: 4500,
            });
            // Server path: ledger awards amounts. Local path already awarded inside discoverDistrict.
            if (rewardService.isServerAuthoritative()) {
              void rewardService.awardGameplay({
                sourceType: 'district_first',
                sourceId: payload.districtId,
                idempotencyKey: `district:${payload.districtId}:first_visit`,
              });
            }
            void rewardService.reportObjective({ objectiveType: 'visit_district', ref: payload.districtId });
            if (userId) {
              const day = new Date().toISOString().slice(0, 10);
              void reportGuildGameplayEvent({
                eventType: 'visit_district',
                ref: payload.districtId,
                idempotencyKey: `district:${payload.districtId}:${day}`,
              });
            }
          }
        });
        scene.events.on('landmark-discovered', (payload: { landmarkId: string; name: string }) => {
          if (cancelled) return;
          if (progressionService.discoverLandmark(payload.landmarkId, {
            skipAwards: rewardService.isServerAuthoritative(),
          })) {
            notificationQueue.push({
              kind: 'system',
              icon: '◆',
              title: 'Landmark Discovered',
              text: payload.name,
              duration: 4000,
            });
            if (rewardService.isServerAuthoritative()) {
              void rewardService.awardGameplay({
                sourceType: 'landmark_first',
                sourceId: payload.landmarkId,
                idempotencyKey: `landmark:${payload.landmarkId}:first_visit`,
              });
            }
            void rewardService.reportObjective({ objectiveType: 'visit_landmark', ref: payload.landmarkId });
            if (userId) {
              const day = new Date().toISOString().slice(0, 10);
              void reportGuildGameplayEvent({
                eventType: 'discover_landmark',
                ref: payload.landmarkId,
                idempotencyKey: `landmark:${payload.landmarkId}:${day}`,
              });
            }
          }
        });
        scene.events.on('interior-discovered', (payload: { interiorId: string; name: string }) => {
          if (cancelled) return;
          if (progressionService.discoverInterior(payload.interiorId, {
            skipAwards: rewardService.isServerAuthoritative(),
          })) {
            notificationQueue.push({
              kind: 'system',
              icon: '◆',
              title: 'Interior Discovered',
              text: payload.name,
              duration: 4000,
            });
            if (rewardService.isServerAuthoritative()) {
              void rewardService.awardGameplay({
                sourceType: 'interior_first',
                sourceId: payload.interiorId,
                idempotencyKey: `interior:${payload.interiorId}:first_visit`,
              });
            }
            void rewardService.reportObjective({ objectiveType: 'enter_interior', ref: payload.interiorId });
          }
        });

        scene.events.on('statue-interact', (payload: { rank: number; name: string; rep: number; isPlayer: boolean }) => {
          if (cancelled) return;
          setDialogueClosing(false);
          setDialogue(null);
          setModalClosing(false);
          setModalZone(null);
          setActiveAction(null);
          setWhaleAlertClosing(false);
          setWhaleAlert(null);
          setStatueModalClosing(false);
          setStatueModal(payload);
          soundManager.play('modal');
          const inspectorName = playerName || 'DegenExplorer';
          appendChatMessage(
            'City Feed',
            `🏛️ ${inspectorName} inspected the #${payload.rank} statue — ${payload.name}.`,
            'event'
          );
          completeLevelIfMatches('inspect_statue');
        });
      },
    });

      gameRef.current = game;
      // Asset Gallery boot skips WorldScene onReady — dismiss loading overlay.
      if (game.galleryMode) setReady(true);

      /* Poll camera + zone-proximity state from Phaser registry.
         Camera state is only pushed into React when it actually changes, so a
         still player triggers zero re-renders of this (large) component — the
         10Hz churn used to compete with Phaser's render loop and cause jank. */
      poll = setInterval(() => {
      if (cancelled || !sceneRef.current) return;
      const reg = sceneRef.current.game?.registry;
      if (!reg) return;
      const cx = Math.round(reg.get('camX') ?? 0);
      const cy = Math.round(reg.get('camY') ?? 0);
      const cz = reg.get('zoom') ?? 0.85;
      if (cx !== lastCamX || cy !== lastCamY || cz !== lastCamZoom) {
        lastCamX = cx; lastCamY = cy; lastCamZoom = cz;
        setCamera({ x: cx, y: cy, zoom: cz });
      }
      setCamNeedsRecenter(!!reg.get('camNeedsRecenter'));
      const nz = reg.get('nearZone') ?? null;
      const nzSig = nz ? nz.id : '';
      if (nzSig !== lastNearZoneSig) { lastNearZoneSig = nzSig; setNearZone(nz); }

      const nd = reg.get('nearDoor') ?? null;
      setNearDoor(nd);
      const ait = reg.get('activeInteractTarget') as typeof activeInteract | null;
      setActiveInteract(ait ? {
        kind: ait.kind,
        id: ait.id,
        name: ait.name,
        desktopPrompt: (ait as { desktopPrompt?: string }).desktopPrompt ?? '',
        mobileLabel: (ait as { mobileLabel?: string }).mobileLabel ?? 'Interact',
        access: (ait as { access?: string | null }).access ?? null,
      } : null);
      setNearTownCrier(reg.get('nearTownCrier') ?? false);
      setInteriorState(reg.get('interiorState') ?? { active: false, buildingId: null, displayName: null });
      setInteriorPrompt(reg.get('nearInteriorPrompt') ?? null);
      const nextMissionState = reg.get('missionState') ?? EMPTY_MISSION_STATE;
      setMissionState({ ...EMPTY_MISSION_STATE, ...nextMissionState });
      setCurrentDistrict(reg.get('currentDistrict') ?? '');

      // Phase 2: hidden quest discovery/completion — server-persist + reward,
      // then toast. Deduped via ref so a mission re-publish never double-fires.
      const hqState = reg.get('hiddenQuestState') as
        | { discoveredIds: string[]; completedIds: string[]; discoveredCount: number; completedCount: number; totalCount: number; delta?: { discovered: string[]; completed: string[] } }
        | undefined;
      if (hqState) {
        setHiddenQuestState({
          discoveredIds: hqState.discoveredIds,
          completedIds: hqState.completedIds,
          discoveredCount: hqState.discoveredCount,
          completedCount: hqState.completedCount,
          totalCount: hqState.totalCount,
        });
        if (userId && hqState.delta) {
          for (const questId of hqState.delta.discovered) {
            if (processedHiddenQuestDiscoveriesRef.current.has(questId)) continue;
            processedHiddenQuestDiscoveriesRef.current.add(questId);
            void discoverHiddenQuest(questId);
            showToast('🔎 Hidden quest discovered!');
          }
          for (const questId of hqState.delta.completed) {
            if (processedHiddenQuestCompletionsRef.current.has(questId)) continue;
            processedHiddenQuestCompletionsRef.current.add(questId);
            void completeHiddenQuest(questId).then((result) => {
              if (result.ok) {
                showToast(`✨ Hidden quest complete! +${result.xpAwarded ?? 0} XP, +${result.repAwarded ?? 0} REP`);
                void recordDailyParticipation();
              }
            });
          }
        }
      }

      const px = reg.get('playerX') ?? 0;
      const py = reg.get('playerY') ?? 0;
      if (spawnPosRef.current === null && px > 0) {
        spawnPosRef.current = { x: px, y: py };
      }
      if (!onboardingDoneRef.current && spawnPosRef.current) {
        const dx = px - spawnPosRef.current.x;
        const dy = py - spawnPosRef.current.y;
        if (dx * dx + dy * dy > 70 * 70) {
          onboardingDoneRef.current = true;
          setOnboardingDone(true);
        }
      }

      const nn = reg.get('nearNpc') ?? null;
      const nnSig = nn ? nn.name : '';
      if (nnSig !== lastNearNpcSig) { lastNearNpcSig = nnSig; setNearNpc(nn); }

      setCollisionDebugOn(reg.get('collisionDebug') ?? false);
      setAssetBoundsDebugOn(reg.get('assetBoundsDebug') ?? false);
      setAssetAnchorsDebugOn(reg.get('assetAnchorsDebug') ?? false);
      setAssetRoadDebugOn(reg.get('assetRoadDebug') ?? false);
      setAssetPlayerDepthDebugOn(reg.get('assetPlayerDepthDebug') ?? false);

      // Event HUD — read-only registry poll, same pattern as everything
      // else above. WorldScene/EventManager remain the only source of
      // truth for the lifecycle; this just mirrors it into React state.
      const evt: RegistryCurrentEvent | null = reg.get('currentEvent') ?? null;
      const phase: EnginePhase = reg.get('eventPhase') ?? 'idle';
      setEventPhase(phase);
      setCurrentEvent(evt);
      // Only push the countdown into React when the displayed second
      // changes, not on every 100ms tick — avoids 10Hz re-renders while an
      // event is live.
      const remainingMs = evt ? Math.max(0, evt.phaseDuration - (Date.now() - evt.phaseStartedAt)) : 0;
      const remainingSec = Math.ceil(remainingMs / 1000);
      if (remainingSec !== lastEventSec) {
        lastEventSec = remainingSec;
        setEventTimeRemaining(remainingMs);
      }

      if (evt) {
        // Fire the chat line (+ toast/sound for the bigger beats) exactly
        // once per phase, not once per 100ms poll tick.
        const key = `${evt.id}:${evt.phase}`;
        if (lastEventChatKeyRef.current !== key) {
          lastEventChatKeyRef.current = key;
          const line = eventChatLine(evt);
          if (line) {
            appendChatMessage('City Feed', `${line.icon} ${line.text}`, 'event');
            if (evt.phase === 'live') {
              notificationQueue.push({
                kind: 'event', icon: line.icon, title: 'Event Live',
                text: `${evt.title} is live!`,
              });
              soundManager.play('event');
              // "Today's Story" only logs the moment an event actually
              // starts — claims (treasure/whale) add their own entries
              // separately, in their respective claim effects below.
              pushStoryLog(storyLogLineForLive(evt));
            } else if (evt.phase === 'announcement') {
              // Mayor announcement — queued (high priority) instead of a
              // separate always-on card, so it never overlaps other alerts.
              notificationQueue.push({
                kind: 'mayor', icon: '📯', title: 'Mayor of RugTown',
                text: `Citizens of RugTown… ${evt.description}`,
                priority: 'high',
              });
              soundManager.play('event');
            }
          }
        }

        // Event Chain System (Phase 4) — Countdown is always a brand new
        // event instance's first phase, so this fires exactly once per
        // chained event, the moment it's first seen (same dedup key as
        // above, just a different condition).
        if (evt.phase === 'countdown' && evt.chainedFrom && lastChainAnnouncedKeyRef.current !== key) {
          lastChainAnnouncedKeyRef.current = key;
          const sourceDef = EVENT_DEFINITIONS.find(d => d.id === evt.chainedFrom);
          const sourceTitle = sourceDef?.title ?? 'previous event';
          const lineFn = CHAIN_TRIGGER_LINES[Math.floor(Math.random() * CHAIN_TRIGGER_LINES.length)];
          appendChatMessage('City Feed', `🔗 ${lineFn(sourceTitle)}`, 'event');
        }
      } else {
        lastEventChatKeyRef.current = null;
        lastChainAnnouncedKeyRef.current = null;
      }

      // Treasure Hunt chest — read-only mirror for the minimap marker and
      // the "Press E to open treasure" prompt below.
      const tc = reg.get('treasureChest') ?? null;
      const tcSig = tc ? `${tc.wx},${tc.wy}` : '';
      if (tcSig !== lastTreasureSig) { lastTreasureSig = tcSig; setTreasureChest(tc); }
      setNearTreasure(reg.get('nearTreasure') ?? false);

      // Whale Alert marker — read-only mirror for the minimap marker and
      // the "Press E to inspect whale" prompt below.
      const wm = reg.get('whaleMarker') ?? null;
      const wmSig = wm ? `${wm.wx},${wm.wy}` : '';
      if (wmSig !== lastWhaleSig) { lastWhaleSig = wmSig; setWhaleMarker(wm); }
      setNearWhale(reg.get('nearWhale') ?? false);

      // Hall of Fame statues — read-only mirror for the "Press E to
      // inspect statue" prompt below (the statues themselves are pushed
      // the other direction, GamePage → WorldScene, in the leaderboard
      // effect above).
      const ns = reg.get('nearStatue') ?? null;
      const nsSig = ns ? `${ns.rank}:${ns.name}` : '';
      if (nsSig !== lastNearStatueSig) { lastNearStatueSig = nsSig; setNearStatue(ns); }
      }, 100);
    });

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      game?.destroy();
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  /* ── Persist route + last safe position (debounced; never every frame) ── */
  useEffect(() => {
    if (!ready) return;

    const persist = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const pos = scene.getPlayerPos();
      const zoom = scene.game?.registry?.get('zoom') as number | undefined;
      const district = (scene.game?.registry?.get('currentDistrict') as string | undefined) || null;
      const mission = (scene.game?.registry?.get('missionState') as { activeMissionId?: string | null } | undefined)
        ?.activeMissionId ?? null;
      saveRugTownSession({
        route: '/play',
        enteredGame: true,
        playerName: playerName || '',
        position: { x: Math.round(pos.x), y: Math.round(pos.y) },
        districtId: district,
        activeMissionId: mission,
        cameraZoom: typeof zoom === 'number' ? zoom : null,
      }, userId);
    };

    persist();
    const id = window.setInterval(persist, 4000);
    const onVis = () => {
      if (document.visibilityState === 'hidden') persist();
    };
    const onUnload = () => persist();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onUnload);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onUnload);
      persist();
    };
  }, [ready, playerName, userId]);

  /* ── HUD keyboard shortcuts ── */
  useEffect(() => {
    const closeLandmarkOverlays = () => {
      setModalClosing(false);
      setModalZone(null);
      setDialogueClosing(false);
      setDialogue(null);
      setWhaleAlertClosing(false);
      setWhaleAlert(null);
      setStatueModalClosing(false);
      setStatueModal(null);
    };
    const closeSpecialPanels = () => {
      setRewardCentreOpen(false);
      setSocialHubOpen(false);
      setPartyPanelOpen(false);
      setEventCentreOpen(false);
      setTournamentCentreOpen(false);
      setGuildPanelOpen(false);
      setRugtownGuildOpen(false);
      setVaultPanelOpen(false);
    };
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const key = e.key.toUpperCase();
      const hud = ACTION_BAR_ITEMS.find(a => a.key === key);
      if (!hud) return;
      closeLandmarkOverlays();
      if (hud.label === 'Rewards') {
        closeSpecialPanels();
        setActiveAction(null);
        setRewardCentreOpen((v) => !v);
        return;
      }
      if (hud.label === 'Social') {
        closeSpecialPanels();
        setActiveAction(null);
        setSocialHubOpen((v) => !v);
        return;
      }
      if (hud.label === 'Party') {
        closeSpecialPanels();
        setActiveAction(null);
        setPartyPanelOpen((v) => {
          const next = !v;
          if (next) {
            sceneRef.current?.reportGameplayEvent({ type: 'PARTY_JOINED' });
            sceneRef.current?.reportGameplayEvent({ type: 'PARTY_ACTION' });
          }
          return next;
        });
        return;
      }
      if (hud.label === 'Events') {
        closeSpecialPanels();
        setActiveAction(null);
        setEventCentreOpen((v) => {
          const next = !v;
          if (next) sceneRef.current?.reportGameplayEvent({ type: 'PANEL_OPENED', panelId: 'events' });
          return next;
        });
        return;
      }
      closeSpecialPanels();
      setActiveAction(prev => prev === hud.label ? null : hud.label);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /* ── Zoom buttons from HUD ── */
  const zoomIn  = useCallback(() => sceneRef.current?.setTargetZoom(camera.zoom + 0.15), [camera.zoom]);
  const zoomOut = useCallback(() => sceneRef.current?.setTargetZoom(camera.zoom - 0.15), [camera.zoom]);
  const resetView = useCallback(() => {
    // Resets zoom + smooth recenter to player (WorldCameraController).
    // Does NOT move the player.
    sceneRef.current?.resetCamera();
  }, []);
  const recenterView = useCallback(() => {
    sceneRef.current?.recenterCamera();
  }, []);

  const mapLive = useMinimapLiveData(
    sceneRef,
    onlinePlayers,
    presenceIdRef.current,
    missionState.highlightZoneId,
  );
  const minimapLandmarks = buildMinimapLandmarks(mapLive.worldW, mapLive.worldH);

  /* ── Mobile layout ──
     isMobile drives the virtual joystick/interact button (touch-only
     controls that make no sense on desktop) and which side panels are
     collapsed into small toggle buttons. Matches the existing ≤600px
     CSS breakpoint that already adapts the rest of the HUD. */
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 600);
  const [mobilePlayerCardOpen, setMobilePlayerCardOpen] = useState(false);
  const [mobileMapOpen, setMobileMapOpen] = useState(false);
  /* Desktop minimap is collapsible to reveal more city — Part B */
  const [desktopMapOpen, setDesktopMapOpen] = useState(true);
  /* Desktop left profile/missions panel — same collapse pattern as the map */
  const [desktopPlayerCardOpen, setDesktopPlayerCardOpen] = useState(true);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= 600);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // If the viewport grows back past the mobile breakpoint mid-touch,
  // make sure the player doesn't keep drifting in the last direction.
  useEffect(() => {
    if (!isMobile) sceneRef.current?.setVirtualMove(0, 0);
  }, [isMobile]);

  /* ── Virtual joystick (movement) — Pointer Events cover touch/mouse/pen
     with one set of handlers; setPointerCapture keeps tracking the same
     finger even if it drifts outside the joystick base. ── */
  const JOYSTICK_RADIUS = 48; // px, matches .mobile-joystick CSS size (~104px base)
  const joystickBaseRef = useRef<HTMLDivElement>(null);
  const joystickPointerIdRef = useRef<number | null>(null);
  const [joystickKnob, setJoystickKnob] = useState({ x: 0, y: 0 });

  const updateJoystickFromPointer = useCallback((clientX: number, clientY: number) => {
    const base = joystickBaseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > JOYSTICK_RADIUS) {
      dx = (dx / dist) * JOYSTICK_RADIUS;
      dy = (dy / dist) * JOYSTICK_RADIUS;
    }
    setJoystickKnob({ x: dx, y: dy });
    sceneRef.current?.setVirtualMove(dx / JOYSTICK_RADIUS, dy / JOYSTICK_RADIUS);
  }, []);

  const endJoystick = useCallback(() => {
    joystickPointerIdRef.current = null;
    setJoystickKnob({ x: 0, y: 0 });
    sceneRef.current?.setVirtualMove(0, 0);
  }, []);

  const handleJoystickPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    joystickPointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateJoystickFromPointer(e.clientX, e.clientY);
  }, [updateJoystickFromPointer]);

  const handleJoystickPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    updateJoystickFromPointer(e.clientX, e.clientY);
  }, [updateJoystickFromPointer]);

  const handleJoystickPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerIdRef.current !== e.pointerId) return;
    endJoystick();
  }, [endJoystick]);

  /* ── Mobile interact button — same effect as one E key press ── */
  const handleMobileInteract = useCallback(() => {
    sceneRef.current?.requestInteract();
  }, []);

  /* ── Interaction zone modal ──
     Closing plays a short exit animation before the modal actually
     unmounts — requestCloseModal triggers it, the effect below clears
     modalZone once the animation has had time to finish. */
  const requestCloseModal = useCallback(() => {
    setModalClosing(true);
  }, []);

  useEffect(() => {
    if (!modalClosing) return;
    const t = setTimeout(() => {
      setModalZone(null);
      setModalClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, [modalClosing]);

  /* ── ESC closes an open modal ── */
  useEffect(() => {
    if (!modalZone) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modalZone, requestCloseModal]);

  const requestCloseStatusModal = useCallback(() => {
    setStatusModalClosing(true);
  }, []);

  useEffect(() => {
    if (!statusModalClosing) return;
    const t = setTimeout(() => {
      setStatusModal(null);
      setStatusModalClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, [statusModalClosing]);

  useEffect(() => {
    if (!statusModal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseStatusModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [statusModal, requestCloseStatusModal]);

  /* ── NPC dialogue — same open/close-animation pattern as the modal ── */
  const requestCloseDialogue = useCallback(() => {
    setDialogueClosing(true);
  }, []);

  useEffect(() => {
    if (!dialogueClosing) return;
    const t = setTimeout(() => {
      setDialogue(null);
      setDialogueClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, [dialogueClosing]);

  /* ── ESC closes an open dialogue ── */
  useEffect(() => {
    if (!dialogue) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseDialogue();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dialogue, requestCloseDialogue]);

  /* ── Whale Alert modal — same open/close-animation pattern as the
     landmark modal/NPC dialogue above. Note: closing this does NOT
     re-grant or revoke REP — that already happened once, synchronously,
     when the marker was inspected (see the whaleClaim effect). ── */
  const requestCloseWhaleAlert = useCallback(() => {
    setWhaleAlertClosing(true);
  }, []);

  useEffect(() => {
    if (!whaleAlertClosing) return;
    const t = setTimeout(() => {
      setWhaleAlert(null);
      setWhaleAlertClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, [whaleAlertClosing]);

  /* ── ESC closes an open Whale Alert modal ── */
  useEffect(() => {
    if (!whaleAlert) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseWhaleAlert();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [whaleAlert, requestCloseWhaleAlert]);

  /* ── Hall of Fame statue modal — same open/close-animation pattern as
     the others. Nothing to grant on close (or open) — statues have no
     reward, just a flavor inspect + chat message, already fired the
     moment the scene event arrived. ── */
  const closeRemoteProfile = useCallback(() => {
    setRemoteProfileClosing(true);
    setTimeout(() => {
      setRemoteProfile(null);
      setRemoteProfileClosing(false);
      setRemoteOfflineNotice(null);
    }, 200);
  }, []);

  const openDirectMessage = useCallback((player: SocialPlayerSummary) => {
    setDmClosing(false);
    setDmRecipient(toDmRecipient(player));
    closeRemoteProfile();
  }, [closeRemoteProfile]);

  const openDirectMessageById = useCallback((playerId: string, username: string) => {
    setDmClosing(false);
    setDmRecipient({ playerId, username, isGuest: playerId.startsWith('guest_') });
    setSocialHubOpen(false);
  }, []);

  const closeDirectMessage = useCallback(() => {
    setDmClosing(true);
    setTimeout(() => {
      setDmRecipient(null);
      setDmClosing(false);
    }, 200);
  }, []);

  useEffect(() => {
    const reg = sceneRef.current?.game?.registry;
    if (!reg) return;
    reg.set('socialCardOpen', !!remoteProfile);
    reg.set('dmRecipient', dmRecipient);
  }, [remoteProfile, dmRecipient]);

  useEffect(() => {
    if (!remoteProfile || !userId || remoteProfile.isGuest) {
      setRemoteFriendship(null);
      return;
    }
    let active = true;
    void socialService.getFriendshipState(remoteProfile.playerId).then((state) => {
      if (active) setRemoteFriendship(state);
    });
    return () => { active = false; };
  }, [remoteProfile, userId]);

  /* ── Phase 10J presence heartbeat (privacy-aware server state) ── */
  useEffect(() => {
    if (!userId) return;
    const tick = () => {
      void socialService.heartbeatPresence({
        status: 'online',
        districtId: currentDistrict || undefined,
      });
      void partyService.heartbeat(currentDistrict || undefined);
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [userId, currentDistrict]);

  const requestCloseStatueModal = useCallback(() => {
    setStatueModalClosing(true);
  }, []);

  useEffect(() => {
    if (!statueModalClosing) return;
    const t = setTimeout(() => {
      setStatueModal(null);
      setStatueModalClosing(false);
    }, 200);
    return () => clearTimeout(t);
  }, [statueModalClosing]);

  /* ── ESC closes an open Hall of Fame statue modal ── */
  useEffect(() => {
    if (!statueModal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseStatueModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [statueModal, requestCloseStatueModal]);

  /* ── Chat panel ── */
  const sendChatMessage = useCallback(() => {
    const safety = sanitizeCityChat(chatInput);
    if (!safety.ok) {
      showToast(
        safety.reason === 'seed_phrase' || safety.reason === 'scam_language'
          ? 'Message blocked for safety'
          : 'Message could not be sent',
      );
      return;
    }
    const text = safety.safeText;
    appendChatMessage(playerName || 'DegenExplorer', text, 'player');
    setChatInput('');
    sceneRef.current?.showPlayerSpeech(text);
    soundManager.play('chatSend');
    // Broadcast to other real players — NPC and event messages are
    // never sent here so they stay local.  channelSubscribedRef guards
    // against calling send() before the channel is fully subscribed.
    // Sender display name is local identity only; DMs use server auth.
    if (channelSubscribedRef.current) {
      const payload: ChatBroadcast = {
        id:        makeChatMessageId(presenceIdRef.current),
        senderId:  presenceIdRef.current,
        sender:    playerName || 'DegenExplorer',
        text,
        timestamp: Date.now(),
      };
      cityChannelRef.current?.send({ type: 'broadcast', event: 'chat', payload }).catch(() => {});
    }
    completeLevelIfMatches('send_chat');
    sceneRef.current?.reportGameplayEvent({ type: 'CHAT_SENT' });
    emitGameplayEvent({ type: 'CHAT_SENT' });
  }, [chatInput, playerName, appendChatMessage, completeLevelIfMatches, showToast]);

  const handleChatInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') sendChatMessage();
  }, [sendChatMessage]);

  /* ── Emotes ── */
  const isEmotesOpen = activeAction === 'Emotes';

  const triggerEmote = useCallback((emote: Emote) => {
    // Local player — unchanged
    sceneRef.current?.showPlayerSpeech(`${emote.icon} ${emote.label}`, EMOTE_BUBBLE_DURATION);
    sceneRef.current?.playEmoteAnimation();
    appendChatMessage(playerName || 'DegenExplorer', `used ${emote.label}`, 'player');
    // Broadcast to other real players — no-op for guests or before subscribe
    if (channelSubscribedRef.current) {
      cityChannelRef.current?.send({
        type: 'broadcast',
        event: 'emote',
        payload: {
          senderId:  presenceIdRef.current,
          sender:    playerName || 'DegenExplorer',
          emoteId:   emote.id,
          timestamp: Date.now(),
        },
      }).catch(() => {});
    }
    completeLevelIfMatches('use_emote');
    sceneRef.current?.reportGameplayEvent({ type: 'EMOTE_USED' });
  }, [playerName, appendChatMessage, completeLevelIfMatches]);

  // Declared after triggerEmote so the dependency is satisfied
  const waveAtRemotePlayer = useCallback(() => {
    const waveEmote = EMOTES.find(e => e.id === 'wave');
    if (waveEmote) triggerEmote(waveEmote);
    progressionService.onWaveSent();
    void rewardService.reportObjective({ objectiveType: 'wave_player' });
    if (rewardService.isServerAuthoritative()) {
      void rewardService.awardGameplay({
        sourceType: 'wave_once',
        sourceId: 'wave',
        idempotencyKey: 'social:wave:once',
      });
    }
    closeRemoteProfile();
  }, [triggerEmote, closeRemoteProfile]);

  // ESC closes whichever action-bar panel is open — Chat, Quests, Holder,
  // Leaderboard, Settings, Inventory, and Emotes all share `activeAction`.
  // (Blurring the chat input, if focused, also lets WorldScene's keyboard
  // re-enable via the input's own onBlur.)
  useEffect(() => {
    if (!activeAction) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveAction(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeAction]);

  // Keep the log scrolled to the newest message
  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const claimFountainReward = useCallback(() => {
    if (fountainClaimed) return;
    const amount = applyHolderMultiplier(5);
    setRep(r => r + amount);
    setFountainClaimed(true);
    setRewardFlash(k => k + 1);
    sceneRef.current?.playRewardEffect(`+${amount} REP`);
    soundManager.play('reward');
    // Tell WorldScene to stop the onboarding fountain glow.
    sceneRef.current?.game?.registry?.set('fountainClaimed', true);
    progressionService.recordExternalRepGrant({
      amount,
      reason: 'Fountain claim',
      idempotencyKey: 'fountain:claim:rep',
    });
    progressionService.onFountainClaimed();
  }, [fountainClaimed, applyHolderMultiplier]);

  /* ── Onboarding: dismiss when fountain REP is claimed ── */
  useEffect(() => {
    if (fountainClaimed) {
      onboardingDoneRef.current = true;
      setOnboardingDone(true);
    }
  }, [fountainClaimed]);

  /* ── Onboarding: auto-hide after 8 seconds (Phase 7) ── */
  useEffect(() => {
    if (!ready || onboardingDone) return;
    const timer = setTimeout(() => {
      onboardingDoneRef.current = true;
      setOnboardingDone(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, [ready, onboardingDone]);

  /* ── Onboarding: 15-second idle hint ── */
  useEffect(() => {
    if (!ready || onboardingDone || fountainClaimed) {
      setIdleHintVisible(false);
      return;
    }
    const timer = setTimeout(() => setIdleHintVisible(true), 15_000);
    return () => clearTimeout(timer);
  }, [ready, onboardingDone, fountainClaimed]);

  /* ── Quest auto-completion — each just watches state GamePage already
     tracks for other features; nothing new is requested from WorldScene. ── */
  useEffect(() => {
    if (fountainClaimed) markQuestReady('fountain-claim');
  }, [fountainClaimed, markQuestReady]);

  useEffect(() => {
    if (nearZone?.id === 'market') markQuestReady('visit-market');
  }, [nearZone, markQuestReady]);

  useEffect(() => {
    if (dialogue) markQuestReady('talk-npc');
  }, [dialogue, markQuestReady]);

  useEffect(() => {
    if (nearZone?.id === 'whale') markQuestReady('check-whale');
  }, [nearZone, markQuestReady]);

  /* ── Badge unlocks — same trigger state as the quests above, reused
     as-is (no changes to quest logic), just driving a separate badge
     unlock list instead. ── */
  useEffect(() => {
    if (rep > 0) unlockBadge('first-rep');
  }, [rep, unlockBadge]);

  useEffect(() => {
    if (fountainClaimed) unlockBadge('fountain-visitor');
  }, [fountainClaimed, unlockBadge]);

  useEffect(() => {
    if (nearZone?.id === 'market') unlockBadge('market-scout');
  }, [nearZone, unlockBadge]);

  useEffect(() => {
    if (dialogue) unlockBadge('npc-talker');
  }, [dialogue, unlockBadge]);

  useEffect(() => {
    if (nearZone?.id === 'whale') unlockBadge('whale-watcher');
  }, [nearZone, unlockBadge]);

  /* ── Level progression triggers — one effect per trigger type.
     Including currentLevel as a dep lets newly-completed levels fire
     immediately if the condition is already met (chaining behavior).
     The levelCompletedRef guard inside completeLevelIfMatches prevents
     the same level id from completing twice even if multiple effects
     fire in the same batch. ── */
  useEffect(() => { currentLevelRef.current = currentLevel; }, [currentLevel]);
  useEffect(() => {
    localStorage.setItem('rugtown:currentLevel', String(currentLevel));
  }, [currentLevel]);

  useEffect(() => {
    if (fountainClaimed) completeLevelIfMatches('claim_fountain');
  }, [fountainClaimed, currentLevel, completeLevelIfMatches]);

  useEffect(() => {
    if (nearZone) completeLevelIfMatches('visit_zone', nearZone.id);
  }, [nearZone, currentLevel, completeLevelIfMatches]);

  useEffect(() => {
    if (dialogue) completeLevelIfMatches('talk_npc');
  }, [dialogue, currentLevel, completeLevelIfMatches]);

  useEffect(() => {
    const def = currentLevelDef;
    if (def?.objectiveType === 'rep_reached' && typeof def.target === 'number' && rep >= def.target) {
      completeLevelIfMatches('rep_reached', def.target);
    }
  }, [rep, currentLevel, currentLevelDef, completeLevelIfMatches]);

  /* ── Mission zone pulse — tell WorldScene which landmark to highlight
     whenever the current mission changes. Runs on every level advance and
     on initial mount (sceneRef may be null initially; that's fine — the
     onReady callback above handles the initial call). ── */
  useEffect(() => {
    const zoneId = missionState.highlightZoneId ?? (currentLevelDef?.objectiveType === 'visit_zone'
      ? (currentLevelDef.target as string)
      : null);
    sceneRef.current?.setActiveMissionZone(zoneId ?? null);
  }, [currentLevelDef, missionState.highlightZoneId]);

  /* ── Phase 5: REP reward on mission completion ────────────────────
     Watches the mirrored mission list. The first time a mission shows as
     completed (and hasn't been rewarded before — the ref is seeded from the
     save so it never double-grants across reloads), award its REP, show the
     floating reward text in-world, flash, and post feedback. WorldScene has
     already persisted the completed mission id by the time we see it. ── */
  useEffect(() => {
    for (const m of missionState.missions) {
      if (!m.completed || rewardedMissionsRef.current.has(m.id)) continue;
      rewardedMissionsRef.current.add(m.id);

      const showCompletion = (xp: number, repAmount: number, repAbsolute?: number) => {
        if (typeof repAbsolute === 'number') {
          setRep(repAbsolute);
        } else {
          setRep(r => r + repAmount);
        }
        setRewardFlash(k => k + 1);
        sceneRef.current?.playRewardEffect(`+${xp} XP · +${repAmount} REP`);
        soundManager.play('reward');
        showToast(`Mission complete: ${m.title} (+${xp} XP, +${repAmount} REP)`);
        appendChatMessage('City Feed', `✅ Mission complete: ${m.title} — +${xp} XP, +${repAmount} REP`, 'event');
        if (userId) {
          void reportGuildGameplayEvent({
            eventType: 'complete_mission',
            idempotencyKey: `mission:${m.id}:guild`,
          });
          void recordRewardPoints({
            sourceType: 'mission',
            sourceId: m.id,
            basePoints: DEFAULT_MISSION_RP,
            idempotencyKey: `mission:${m.id}:rp`,
          });
        }
      };

      if (rewardService.isServerAuthoritative() && m.id.startsWith('ch1_')) {
        void rewardService.completeChapterMission(m.id).then((result) => {
          if (result.error && !result.duplicate) {
            rewardedMissionsRef.current.delete(m.id);
            showToast(`Mission reward pending — try again shortly.`);
            return;
          }
          const xp = result.xpAwarded ?? m.rewardXp;
          const repAmount = result.repAwarded ?? m.rewardRep;
          const repAbsolute = result.progression
            ? Number(result.progression.rep)
            : undefined;
          showCompletion(xp, repAmount, repAbsolute);
        });
        continue;
      }

      const repAmount = m.rewardRep;
      showCompletion(m.rewardXp, repAmount);
      progressionService.recordExternalRepGrant({
        amount: repAmount,
        reason: `Mission ${m.id}`,
        idempotencyKey: `mission:${m.id}:complete:rep`,
      });
      progressionService.onMissionCompleted(m.id, m.rewardXp);
    }
  }, [missionState.missions, showToast, appendChatMessage, userId]);

  /* ── Phase 5: persist REP locally so it survives reloads (guests too).
     Logged-in users additionally sync to Supabase in the effect below. ── */
  useEffect(() => {
    patchProgress({ rep });
    progressionService.syncRepAbsolute(rep);
  }, [rep]);

  /* ── Debounced REP sync for guests only ─────────────────────────
     For authenticated users, REP is persisted server-side by
     award_gameplay_reward / complete_chapter_mission RPCs.  The direct
     profiles.update call is blocked by the profiles_protect_reward_columns
     trigger on Phase 10G+ databases, so calling it for authenticated users
     produces a silent no-op at best and a confusing non-authoritative write
     at worst.  ProgressionService.scheduleServerSync() handles the
     authoritative push for logged-in players via push_progression_snapshot. */
  const repSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Only call saveRep for guests — authenticated users use server RPCs.
    if (userId) return;
    if (repSaveTimerRef.current) clearTimeout(repSaveTimerRef.current);
    repSaveTimerRef.current = setTimeout(() => {
      // Guest: there is no userId, so saveRep would be a no-op anyway, but
      // we keep the patchProgress call to keep the legacy local store in sync.
      patchProgress({ rep });
    }, 3000);
    return () => {
      if (repSaveTimerRef.current) clearTimeout(repSaveTimerRef.current);
    };
  }, [rep, userId]);

  /* ── Presence broadcast refs — keep latest mutable values in sync ──
     setInterval closures can't read React state directly (stale closure),
     so we mirror the values we need into refs on every render they change. */
  useEffect(() => { repRef.current = rep; }, [rep]);
  useEffect(() => { holderTierRef.current = holderTier; }, [holderTier]);
  useEffect(() => { playerNameRef.current = playerName || 'DegenExplorer'; }, [playerName]);
  useEffect(() => {
    appearanceRef.current = getCanonicalPlayerAppearance();
    sceneRef.current?.setAppearance(appearanceRef.current);
  }, [appearance]);

  /* ── Realtime Presence — city channel subscription ───────────────
     Guests get a random guest id, logged-in users use their Supabase
     user id. Position is broadcast at ~150ms rate; the sync callback
     updates onlineCount and pushes the remote player list to WorldScene.
     Gracefully skipped if Supabase is not configured. ── */
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setConnState('offline');
      return; // Supabase not configured — guest-only mode
    }

    // A single connection attempt is wrapped in connect() so it can be retried
    // on transient failures (network drop, or the React StrictMode double-mount
    // in dev, which briefly tears down the shared realtime socket). The channel
    // self-heals instead of latching to Offline on the first close.
    let disposed = false;
    let channel: ReturnType<typeof createCityChannel> = null;
    let broadcastTimer: ReturnType<typeof setInterval> | null = null;
    let connectTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    // Once we reach SUBSCRIBED the first time, reconnects happen silently —
    // no more "Connecting…" flicker on keep-alive cycles or brief drops.
    let hasEverConnected = false;

    const teardownChannel = () => {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
      if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
      channelSubscribedRef.current = false;
      if (channel) { removeCityChannel(channel); channel = null; }
      cityChannelRef.current = null;
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      const delay = Math.min(1500 * 2 ** retries, 8000);
      retries += 1;
      retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      teardownChannel();
      await syncRealtimeAuth();
      if (disposed) return;

      const ch = createCityChannel(presenceIdRef.current);
      if (!ch) { setConnState('offline'); return; }
      channel = ch;
      cityChannelRef.current = ch;
      // Only show "Connecting…" on the first-ever attempt. After that,
      // stay on 'online' during reconnects so the HUD never flickers.
      if (!hasEverConnected) setConnState('connecting');

      // Fail-safe: only flip to Offline on a truly stuck first connection.
      connectTimeout = setTimeout(() => {
        if (!channelSubscribedRef.current && !disposed) {
          if (!hasEverConnected) setConnState('offline');
          setPresenceFailed(true);
          scheduleReconnect();
        }
      }, 10000);

      ch
        .on('broadcast', { event: 'chat' }, ({ payload }: { payload: Partial<ChatBroadcast> }) => {
          if (!payload?.sender || !payload?.text) return;
          // Self-echo safety: never render our own broadcast twice (Supabase
          // broadcast doesn't echo by default, but guard regardless — req 7).
          if (payload.senderId && payload.senderId === presenceIdRef.current) return;
          // Dedup duplicate network deliveries of the same message id (req 7).
          if (payload.id) {
            if (receivedChatIdsRef.current.has(payload.id)) return;
            if (receivedChatIdsRef.current.size > 500) receivedChatIdsRef.current.clear();
            receivedChatIdsRef.current.add(payload.id);
          }
          const safety = sanitizeCityChat(String(payload.text), 140);
          if (!safety.ok) return;
          // Prefer presence username for authenticated peers when available
          // to reduce display-name spoofing in the local log.
          const peers = onlinePlayersRef.current ?? [];
          const peer = payload.senderId
            ? peers.find((p) => p.id === payload.senderId)
            : undefined;
          const displaySender = peer?.username || payload.sender;
          appendChatMessage(displaySender, safety.safeText, 'player');
        })
        .on('broadcast', { event: 'emote' }, ({ payload }: {
          payload: { senderId: string; sender: string; emoteId: string; timestamp: number };
        }) => {
          if (!payload?.senderId || !payload?.emoteId) return;
          // Dedup — ignore duplicate network deliveries of the same emote
          const key = `${payload.senderId}:${payload.timestamp}`;
          if (receivedEmoteKeysRef.current.has(key)) return;
          if (receivedEmoteKeysRef.current.size > 500) receivedEmoteKeysRef.current.clear();
          receivedEmoteKeysRef.current.add(key);
          const emote = EMOTES.find(e => e.id === payload.emoteId);
          if (!emote) return;
          sceneRef.current?.showRemotePlayerEmote(
            payload.senderId,
            `${emote.icon} ${emote.label}`,
            EMOTE_BUBBLE_DURATION,
          );
        })
        .on('presence', { event: 'sync' }, () => {
          const state = ch.presenceState<PresencePayload>();
          const all = flattenPresenceState(
            state as Record<string, PresencePayload[] | undefined>,
          ).filter((p) => !p.id.startsWith('observer_'));
          setOnlineCount(all.length);
          const remotes = all.filter(p => p.id !== presenceIdRef.current);
          setOnlinePlayers(remotes);
          onlinePlayersRef.current = remotes;
          sceneRef.current?.setRemotePlayers(all, presenceIdRef.current);
          // Overlay server-approved loadouts for authenticated UUID peers.
          const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          void (async () => {
            const trusted: Record<string, CharacterAppearanceV1> = {};
            await Promise.all(remotes.slice(0, 24).map(async (p) => {
              if (!uuidRe.test(p.id)) return;
              if (!supabase) return;
              const { data } = await supabase.rpc('get_public_character_appearance', { p_player: p.id });
              if (data && data !== 'null') {
                const row = data as { appearance?: unknown };
                trusted[p.id] = decodeCharacterAppearance(row.appearance, assetExists);
              } else {
                trusted[p.id] = decodeCharacterAppearance(p.appearance, assetExists);
              }
            }));
            if (Object.keys(trusted).length) {
              sceneRef.current?.applyTrustedRemoteAppearances(trusted);
            }
          })();
        })
        .subscribe(async (status) => {
          if (import.meta.env.DEV) {
            console.info('[presence] game', status, {
              configured: isSupabaseConfigured,
              keyPrefix: presenceIdRef.current.slice(0, 8),
            });
          }
          if (disposed) return;
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            channelSubscribedRef.current = false;
            if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
            // Once the player has been online, reconnect silently — never
            // flash "Connecting…" for keep-alive cycles or brief drops.
            if (!hasEverConnected) setConnState('connecting');
            setPresenceFailed(true);
            scheduleReconnect();
            return;
          }
          if (status !== 'SUBSCRIBED') return;
          hasEverConnected = true;
          retries = 0;
          channelSubscribedRef.current = true;
          setPresenceFailed(false);
          setConnState('online');
          if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
          if (userId) updateLastSeen(userId).catch(() => {});
          const pos = sceneRef.current?.getPlayerPos() ?? { x: 0, y: 0 };
          await ch.track({
            id:         presenceIdRef.current,
            username:   playerNameRef.current,
            x:          Math.round(pos.x),
            y:          Math.round(pos.y),
            appearance: encodeCharacterAppearance(appearanceRef.current),
            appearanceRev: characterAppearanceService.getRevision(),
            rep:        repRef.current,
            holderTier: holderTierRef.current,
            level:      progressionRef.current?.level ?? 1,
            rankLabel:  progressionRef.current
              ? rankDisplayName(progressionRef.current.rankTier)
              : 'Drifter',
            equippedTitle: titleDisplayName(progressionRef.current?.equippedTitleId) ?? undefined,
          } as Record<string, unknown>).catch(() => {});
        });

      // Throttled position + state broadcast — 300ms keeps network light
      // while still showing other players moving smoothly enough.
      // Presence track replaces the full meta blob — always include a
      // compact appearance string; remotes skip rebuilds via appearanceRev.
      broadcastTimer = setInterval(() => {
        if (!channelSubscribedRef.current) return;
        const pos = sceneRef.current?.getPlayerPos() ?? { x: 0, y: 0 };
        const rev = characterAppearanceService.getRevision();
        ch.track({
          id:         presenceIdRef.current,
          username:   playerNameRef.current,
          x:          Math.round(pos.x),
          y:          Math.round(pos.y),
          appearance: encodeCharacterAppearance(appearanceRef.current),
          appearanceRev: rev,
          rep:        repRef.current,
          holderTier: holderTierRef.current,
          level:      progressionRef.current?.level ?? 1,
          rankLabel:  progressionRef.current
            ? rankDisplayName(progressionRef.current.rankTier)
            : 'Drifter',
          equippedTitle: titleDisplayName(progressionRef.current?.equippedTitleId) ?? undefined,
        } as Record<string, unknown>).catch(() => {});
      }, 300);
    };

    void connect();

    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      if (!channelSubscribedRef.current) {
        void connect();
      } else {
        void syncRealtimeAuth();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      teardownChannel();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Inventory sync for logged-in users ─────────────────────────
     On first login (initialOwnedItemIds is empty) all MOCK_ITEMS are saved
     to player_inventory as the player's "starting kit".  On subsequent
     logins only items not yet in the DB are upserted (idempotent on
     UNIQUE(user_id, item_id)).  Guests are skipped. ── */
  useEffect(() => {
    if (!userId) return;
    const owned = new Set(initialOwnedItemIds ?? []);
    MOCK_ITEMS.forEach(item => {
      if (!owned.has(item.id)) {
        saveInventoryItem(userId, item.id).catch(() => {});
      }
    });
  // Run once per login session — userId and initialOwnedItemIds are stable
  // after the component mounts (both come from App.tsx's loadUserData).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  /* ── Treasure Hunt claim — fires once per claimId (WorldScene already
     guarantees a chest can only ever be claimed once, by destroying it
     synchronously before emitting 'treasure-interact'). Lives in an
     effect rather than directly in the scene-event listener above so it
     always reads fresh playerName/holderMultiplier/showToast instead of
     whatever they were when the listener was registered. ── */
  useEffect(() => {
    if (!treasureClaim) return;
    const amount = applyHolderMultiplier(treasureClaim.amount);
    setRep(r => r + amount);
    setRewardFlash(k => k + 1);
    sceneRef.current?.playRewardEffect(`+${amount} REP`);
    soundManager.play('reward');
    unlockBadge('treasure-finder');
    const name = playerName || 'DegenExplorer';
    appendChatMessage('City Feed', `🏆 ${name} found the treasure!`, 'event');
    notificationQueue.push({
      kind: 'treasure', icon: '🏆', title: 'Treasure Hunt',
      text: `Treasure found! +${amount} REP`, priority: 'high',
    });
    pushStoryLog(`${name} found the treasure`);
    completeLevelIfMatches('claim_treasure');
    progressionService.recordExternalRepGrant({
      amount,
      reason: 'Treasure claim',
      idempotencyKey: `event:treasure-hunt:${treasureClaim.claimId}:rep`,
    });
    progressionService.onCityEventJoined('treasure-hunt', treasureClaim.claimId);
    void rewardService.reportObjective({ objectiveType: 'join_event', ref: 'treasure-hunt' });
    sceneRef.current?.reportGameplayEvent({ type: 'CITY_EVENT_JOINED', eventId: 'treasure-hunt' });
    if (userId) {
      void reportGuildGameplayEvent({
        eventType: 'join_event',
        ref: 'treasure-hunt',
        idempotencyKey: `event:treasure-hunt:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }, [treasureClaim, applyHolderMultiplier, unlockBadge, appendChatMessage, playerName, showToast, pushStoryLog, completeLevelIfMatches, userId]);

  /* ── Whale Alert claim — same one-shot pattern as the treasure claim
     above (WorldScene destroys the marker before emitting, so this only
     ever fires once per event). "Inspecting" the whale (the E press,
     which already opened the modal in the listener above) is what grants
     the REP — not closing the modal. ── */
  useEffect(() => {
    if (!whaleClaim) return;
    const amount = applyHolderMultiplier(whaleClaim.amount);
    setRep(r => r + amount);
    setRewardFlash(k => k + 1);
    sceneRef.current?.playRewardEffect(`+${amount} REP`);
    soundManager.play('reward');
    unlockBadge('whale-watcher-plus');
    const name = playerName || 'DegenExplorer';
    appendChatMessage('City Feed', `🐳 ${name} inspected the whale alert!`, 'event');
    notificationQueue.push({
      kind: 'whale', icon: '🐳', title: 'Whale Alert',
      text: `Whale inspected! +${amount} REP`, priority: 'high',
    });
    pushStoryLog(`${name} inspected the whale`);
    completeLevelIfMatches('inspect_whale');
    progressionService.recordExternalRepGrant({
      amount,
      reason: 'Whale inspect',
      idempotencyKey: `event:whale-alert:${whaleClaim.claimId}:rep`,
    });
    progressionService.onCityEventJoined('whale-alert', whaleClaim.claimId);
    void rewardService.reportObjective({ objectiveType: 'join_event', ref: 'whale-alert' });
    sceneRef.current?.reportGameplayEvent({ type: 'CITY_EVENT_JOINED', eventId: 'whale-alert' });
    if (userId) {
      void reportGuildGameplayEvent({
        eventType: 'join_event',
        ref: 'whale-alert',
        idempotencyKey: `event:whale-alert:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }, [whaleClaim, applyHolderMultiplier, unlockBadge, appendChatMessage, playerName, showToast, pushStoryLog, completeLevelIfMatches]);

  /* ── District unlocks — same trigger state as the quests/badges above. ── */
  useEffect(() => {
    if (fountainClaimed) unlockDistrict('meme-market');
  }, [fountainClaimed, unlockDistrict]);

  useEffect(() => {
    if (nearZone?.id === 'market') unlockDistrict('hall-of-fame');
  }, [nearZone, unlockDistrict]);

  useEffect(() => {
    if (rep >= 20) unlockDistrict('whale-tower');
  }, [rep, unlockDistrict]);

  useEffect(() => {
    if (dialogue) unlockDistrict('alpha-lounge');
  }, [dialogue, unlockDistrict]);

  useEffect(() => {
    if (nearZone?.id === 'whale') unlockDistrict('rug-alley');
  }, [nearZone, unlockDistrict]);

  // Holder Vault is "only when Gold", not "after reaching Gold once" — it's
  // the one district that can re-lock if the (mock) tier changes back down.
  // Toasts on each transition into Gold, not just the first time ever.
  useEffect(() => {
    const isGold = holderTier === 'Gold';
    setDistrictUnlocked(prev => (prev['holder-vault'] === isGold ? prev : { ...prev, 'holder-vault': isGold }));
    if (isGold && !wasGoldRef.current) {
      showToast('🗺️ District unlocked: Holder Vault');
    }
    wasGoldRef.current = isGold;
  }, [holderTier, showToast]);

  /* ── Clear the global notification queue when leaving the game so no
     timers leak and no stale notification survives across sessions. ── */
  useEffect(() => () => notificationQueue.reset(), []);

  /* ── Reset event alert dismissals whenever the event phase changes.
     A new phase means genuinely new information worth showing again. ── */
  useEffect(() => {
    setEventBannerDismissed(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEvent?.id, eventPhase]);

  /* ── Living City Events (Phase 6) ──
     Self-rescheduling timer (30–60s) — fires a district-themed city event
     as toast + City Feed, optionally as NPC speech + floating world text. */
  const triggerCityEvent = useCallback(() => {
    const template = pickLivingCityEvent();
    const message = template.messages[Math.floor(Math.random() * template.messages.length)];
    showToast(`${template.icon} ${message}`);
    appendChatMessage('City Feed', `${template.icon} ${message}`, 'event');
    soundManager.play('event');
    if (Math.random() < 0.45) {
      sceneRef.current?.showNpcEventSpeech(message);
    }
    if (Math.random() < template.worldTextChance) {
      sceneRef.current?.showDistrictFloatingText(
        template.fx,
        template.fy,
        `${template.icon} ${template.type}`,
      );
    }
  }, [showToast, appendChatMessage]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const delay = LIVING_CITY_EVENT_MIN_GAP
        + Math.random() * (LIVING_CITY_EVENT_MAX_GAP - LIVING_CITY_EVENT_MIN_GAP);
      timer = setTimeout(() => {
        triggerCityEvent();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => clearTimeout(timer);
  }, [triggerCityEvent]);

  /* ── RugTown Citizens chat activity ──
     Self-rescheduling timer (9-19s, randomized) drawing on the real,
     session-randomized citizen names WorldScene published — never a
     fixed/fake roster. Picks one of: reply to another named citizen,
     mention a nearby district, or welcome the player. */
  const triggerNpcChatActivity = useCallback(() => {
    if (npcNames.length === 0) return;
    const roll = Math.random();

    if (roll < 0.34 && npcNames.length >= 2) {
      const a = npcNames[Math.floor(Math.random() * npcNames.length)];
      let b = a;
      for (let guard = 0; guard < 5 && b === a; guard++) {
        b = npcNames[Math.floor(Math.random() * npcNames.length)];
      }
      const line = NPC_REPLY_LINES[Math.floor(Math.random() * NPC_REPLY_LINES.length)];
      appendChatMessage(b, `@${a} ${line}`, 'npc');
    } else if (roll < 0.67) {
      const name = npcNames[Math.floor(Math.random() * npcNames.length)];
      const district = DISTRICTS[Math.floor(Math.random() * DISTRICTS.length)];
      const lineFn = NPC_DISTRICT_LINES[Math.floor(Math.random() * NPC_DISTRICT_LINES.length)];
      appendChatMessage(name, lineFn(district.name), 'npc');
    } else {
      const name = npcNames[Math.floor(Math.random() * npcNames.length)];
      const lineFn = NPC_WELCOME_LINES[Math.floor(Math.random() * NPC_WELCOME_LINES.length)];
      appendChatMessage(name, lineFn(playerName || 'DegenExplorer'), 'npc');
    }
  }, [npcNames, playerName, appendChatMessage]);

  useEffect(() => {
    if (npcNames.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const delay = NPC_CHAT_ACTIVITY_MIN_GAP + Math.random() * (NPC_CHAT_ACTIVITY_MAX_GAP - NPC_CHAT_ACTIVITY_MIN_GAP);
      timer = setTimeout(() => {
        triggerNpcChatActivity();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => clearTimeout(timer);
  }, [npcNames, triggerNpcChatActivity]);

  /* ── RugTown Citizens reacting to live Meme Market data ──
     Self-rescheduling timer (20-40s, randomized) — separate channel
     from the general chat-activity timer above, picking one real
     trending token per cycle and posting one real-data line about it.
     Silently skips a cycle on a fetch error rather than surfacing an
     error to the player — the Market panel already owns that UI. */
  const triggerMarketReaction = useCallback(async () => {
    if (npcNames.length === 0) return;
    let tokens: MarketToken[];
    try {
      tokens = await fetchTrendingSolanaTokens();
    } catch {
      return;
    }
    if (tokens.length === 0) return;

    const token = tokens[Math.floor(Math.random() * tokens.length)];
    const line = buildMarketReactionLine(token);
    if (!line) return;

    const name = npcNames[Math.floor(Math.random() * npcNames.length)];
    appendChatMessage(name, line, 'npc');
    // Only sometimes also borrows a citizen's speech bubble (req. 6) —
    // every cycle would feel like a banner ad floating over the city.
    if (Math.random() < 0.5) {
      sceneRef.current?.showNpcEventSpeech(line);
    }
  }, [npcNames, appendChatMessage]);

  useEffect(() => {
    if (npcNames.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const scheduleNext = () => {
      const delay = MARKET_REACTION_MIN_GAP + Math.random() * (MARKET_REACTION_MAX_GAP - MARKET_REACTION_MIN_GAP);
      timer = setTimeout(() => {
        if (cancelled) return;
        void triggerMarketReaction().finally(() => {
          if (!cancelled) scheduleNext();
        });
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [npcNames, triggerMarketReaction]);

  const MEDALS = ['🥇', '🥈', '🥉'];

  const renderModalBody = (id: string) => {
    switch (id) {
      case 'fountain':
        return (
          <>
            <p className="modal-text">
              Coins glint under the water. Toss one in and the fountain hums with old degen luck.
            </p>
            <div className={`modal-reward-row ${fountainClaimed ? 'modal-reward-row--claimed' : ''}`}>
              <span className="modal-reward-label">Daily Reward</span>
              <span className="modal-reward-value">+{applyHolderMultiplier(5)} REP</span>
            </div>
            <button
              className="modal-action-btn"
              onClick={claimFountainReward}
              disabled={fountainClaimed}
            >
              {fountainClaimed ? '✓ Claimed for Today' : 'Claim Reward'}
            </button>
          </>
        );
      case 'market':
        return <MarketPanel />;
      case 'bridge':
        return (
          <>
            <p className="modal-text">
              City Travel Notice: this bridge connects RugTown's central square to the outer
              districts. Travel beyond the bridge opens as new districts are completed.
            </p>
            <ul className="modal-locked-list">
              <li className="modal-locked-item">
                <span className="modal-lock-icon">🔒</span>
                <span>Neon Docks</span>
                <span className="modal-locked-tag">Locked</span>
              </li>
              <li className="modal-locked-item">
                <span className="modal-lock-icon">🔒</span>
                <span>Old Quarter</span>
                <span className="modal-locked-tag">Locked</span>
              </li>
              <li className="modal-locked-item">
                <span className="modal-lock-icon">🔒</span>
                <span>Skybridge Heights</span>
                <span className="modal-locked-tag">Locked</span>
              </li>
            </ul>
          </>
        );
      case 'fame':
        return (
          <ul className="modal-leaderboard">
            {FAME_LEADERBOARD.map(row => (
              <li key={row.rank} className="modal-leaderboard__row">
                <span className="modal-leaderboard__rank">{MEDALS[row.rank - 1] ?? `#${row.rank}`}</span>
                <span>{row.name}</span>
                <span className="modal-leaderboard__rep">{row.rep.toLocaleString()} REP</span>
              </li>
            ))}
            <li className="modal-leaderboard__row modal-leaderboard__row--you">
              <span className="modal-leaderboard__rank">—</span>
              <span>You</span>
              <span className="modal-leaderboard__rep">{rep.toLocaleString()} REP</span>
            </li>
          </ul>
        );
      case 'whale':
        return (
          <>
            <p className="modal-text">Eyes up, degens — something big just moved.</p>
            <div className="modal-whale-card">
              <span className="modal-whale-card__icon">🐳</span>
              <div className="modal-whale-card__body">
                <span className="modal-whale-card__title">Large Wallet Detected</span>
                <span className="modal-whale-card__meta">Near Whale Tower · 3 min ago</span>
              </div>
            </div>
          </>
        );
      case 'notice':
        return (
          <NoticeBoardPanel
            onAcceptMissionLead={() => {
              sceneRef.current?.reportGameplayEvent({ type: 'MISSION_ACCEPTED' });
              sceneRef.current?.reportGameplayEvent({ type: 'PANEL_OPENED', panelId: 'notice' });
              showToast('Mission lead pinned.');
            }}
            onOpenMissions={() => {
              setModalClosing(false);
              setModalZone(null);
              setRewardCentreOpen(true);
              sceneRef.current?.reportGameplayEvent({ type: 'PANEL_OPENED', panelId: 'missions' });
              sceneRef.current?.reportGameplayEvent({ type: 'MISSION_ACCEPTED' });
            }}
          />
        );
      case 'alpha':
        return <AlphaLoungePanel />;
      case 'cashback':
        return (
          <p className="modal-text">
            Quest Archive — records of hidden discoveries across RugTown. Step inside to browse what you've uncovered.
          </p>
        );
      case 'arena':
        return (
          <>
            <p className="modal-text">
              Tournament Hall — register for score challenges and view standings.
              No combat, paid entry, or real-value prizes in this phase.
            </p>
            <button
              type="button"
              className="profile-action-btn profile-action-btn--primary"
              onClick={() => {
                setModalClosing(false);
                setModalZone(null);
                setTournamentCentreOpen(true);
              }}
            >
              Open Tournament Centre
            </button>
          </>
        );
      default: {
        const copy = getGenericBuildingModal(id, rep, progression?.level ?? 1);
        return (
          <>
            {copy.paragraphs.map((p) => (
              <p key={p.slice(0, 24)} className="modal-text">{p}</p>
            ))}
          </>
        );
      }
    }
  };

  /* ── Nearest landmark within interaction radius (compact map status) ── */
  let nearestLandmark: (typeof WORLD_OBJECTS)[number] | null = null;
  const playerPos = { x: mapLive.live.player.x, y: mapLive.live.player.y };
  if (playerPos.x > 0 || playerPos.y > 0) {
    let nearestDist = Infinity;
    for (const obj of WORLD_OBJECTS) {
      const dx = playerPos.x - obj.x * worldSize.w;
      const dy = playerPos.y - obj.y * worldSize.h;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= obj.interactionRadius && dist < nearestDist) {
        nearestLandmark = obj;
        nearestDist = dist;
      }
    }
  }

  /* ── Camera center position for display ── */
  const camCenterX = Math.round(camera.x + (window.innerWidth / 2) / camera.zoom);
  const camCenterY = Math.round(camera.y + (window.innerHeight / 2) / camera.zoom);
  const zoomPct    = Math.round(camera.zoom * 100);

  return (
    <div className="game-page">

      {/* ══════════════════════════════════════════════════════════
          PHASER CANVAS MOUNT
          Full screen behind all HUD elements
          ══════════════════════════════════════════════════════════ */}
      <div
        id="phaser-mount"
        ref={mountRef}
        className="game-canvas"
        aria-label="RugTown world view"
      />

      {/* Loading state — before Phaser is ready */}
      {!ready && (
        <div className="game-loading">
          <div className="game-loading__inner">
            <div className="game-loading__logo">RUGTOWN</div>
            <div className="game-loading__sub">Loading world...</div>
            <div className="game-loading__bar">
              <div className="game-loading__fill" />
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          HUD OVERLAY
          All panels are positioned absolute over the canvas.
          Match Image 2 layout + Image 3 ornate gold style.
          ══════════════════════════════════════════════════════════ */}
      {ready && (
        <>
        <DayNightOverlay />
        <div className="hud" role="complementary" aria-label="Game HUD">
          <WorldEventHud
            isGuest={!userId}
            onOpenCentre={() => {
              setSocialHubOpen(false);
              setPartyPanelOpen(false);
              setRewardCentreOpen(false);
              setEventCentreOpen(true);
            }}
          />

          {/* ──────────────────────────────────────────────────────
              TOP-LEFT: RugTown Logo + Player Card
              Image 2: avatar top-left, name + stats below
              Image 3: ornate gold-bordered panel
              On mobile this collapses into a small toggle button so it
              doesn't permanently cover part of the playfield.
              ────────────────────────────────────────────────────── */}
          {/* ──────────────────────────────────────────────────────
              TOP-LEFT: Player card + Chapter One missions
              Collapsible on desktop (✕) and mobile — same pattern as map.
              ────────────────────────────────────────────────────── */}
          {/* Collapsed toggle — mobile */}
          {isMobile && !mobilePlayerCardOpen && (
            <button
              className="mobile-collapsed-btn mobile-collapsed-btn--tl"
              onClick={() => setMobilePlayerCardOpen(true)}
              aria-label="Show player info"
            >👤</button>
          )}
          {/* Collapsed toggle — desktop */}
          {!isMobile && !desktopPlayerCardOpen && (
            <button
              className="desktop-player-show-btn"
              onClick={() => setDesktopPlayerCardOpen(true)}
              aria-label="Show player panel"
              title="Show player panel"
              data-ui-block-camera
            >👤</button>
          )}
          {(isMobile ? mobilePlayerCardOpen : desktopPlayerCardOpen) && (
          <div className="hud-panel hud-panel--tl">
            {/* Panel corner ornaments — Image 3 style */}
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

            {/* Panel header bar — gold strip + always-visible minimize ✕ */}
            <div className="panel-header panel-header--with-close">
              <span className="panel-header__logo">RUGTOWN</span>
              <span className="panel-header__sub">THE DEGEN CITY</span>
              <button
                type="button"
                className="panel-minimize-btn"
                onClick={() => {
                  if (isMobile) setMobilePlayerCardOpen(false);
                  else setDesktopPlayerCardOpen(false);
                }}
                aria-label="Minimize player panel"
                title="Minimize"
                data-ui-block-camera
              >
                ✕
              </button>
            </div>

            {/* Player card */}
            <div className="player-card">
              <HudCharacterPortrait />
              <div className="player-info">
                <div className="player-name">{playerName || 'DegenExplorer'}</div>
                <div className="player-title">
                  {titleDisplayName(progression?.equippedTitleId)
                    ?? (progression ? rankDisplayName(progression.rankTier) : 'Drifter')}
                </div>
                <div className="player-rep">
                  <span className="rep-label">LVL</span>
                  <span className="rep-value">{progression?.level ?? 1}</span>
                  <span className="rep-label">REP</span>
                  <span className="rep-value">{rep}</span>
                </div>
                <button
                  type="button"
                  className="profile-open-btn"
                  data-ui-block-camera
                  onClick={() => setProfilePanelOpen(true)}
                >
                  View Profile
                </button>
              </div>
            </div>

            {/* Player profile progress (Phase 5) */}
            <div className="player-progress">
              <div className="pprog">
                <span className="pprog__value">{rep}</span>
                <span className="pprog__label">REP</span>
              </div>
              <div className="pprog">
                <span className="pprog__value">{missionState.completedCount}/{missionState.totalCount || 0}</span>
                <span className="pprog__label">Missions</span>
              </div>
              <div className="pprog">
                <span className="pprog__value">{missionState.visitedInteriorsCount}</span>
                <span className="pprog__label">Interiors</span>
              </div>
              <div className="pprog pprog--wide">
                <span className="pprog__value pprog__value--district">{currentDistrict || '—'}</span>
                <span className="pprog__label">District</span>
              </div>
            </div>

            {/* Quick stats */}
            <div className="quick-stats">
              <div className="qstat">
                <span className={`qstat__dot conn-dot conn-dot--${connState}`} />
                <span className="qstat__label">Real Players</span>
                <span className="qstat__value">
                  {connState === 'online'
                    ? (onlineCount ?? 0)
                    : connState === 'connecting'
                      ? 'Connecting…'
                      : 'Offline'}
                </span>
              </div>
              <div className="qstat">
                <span className="qstat__dot" />
                <span className="qstat__label">RugTown Citizens</span>
                <span className="qstat__value">{npcCount || '—'}</span>
              </div>
              <div className={`qstat ${tierJustChanged ? 'qstat--pulse' : ''}`}>
                <span className={`qstat__dot qstat__dot--holder-${holderTier.toLowerCase()}`} />
                <span className="qstat__label">Holder Tier</span>
                <span className="qstat__value">{holderTier} ({holderMultiplier}x)</span>
              </div>
            </div>

            {missionState.missions.length > 0 && (
              <div className="mission-card">
                <div className="mission-card__header">
                  <span>
                    {missionState.missions.find((m) => m.id === missionState.activeMissionId)?.chapterTitle
                      ?? 'RugTown Missions'}
                  </span>
                  <span className={`mission-card__status${missionState.completed ? ' mission-card__status--done' : ''}`}>
                    {missionState.completed
                      ? 'Complete'
                      : `${missionState.completedCount}/${missionState.totalCount}`}
                  </span>
                </div>

                <div className="mission-card__scroll" data-ui-block-camera>
                  {missionState.completed ? (
                    <div className="mission-active mission-active--done">
                      <span className="mission-active__label">Campaign complete</span>
                      <span className="mission-active__title">Daily and weekly quests stay in Rewards.</span>
                    </div>
                  ) : null}

                  <div className="mission-card__list">
                    {missionState.missions.map(mission => {
                      const isActive = !mission.completed && mission.id === missionState.activeMissionId;
                      return (
                        <div
                          key={mission.id}
                          className={`mission-row${mission.completed ? ' mission-row--done' : ''}${isActive ? ' mission-row--active' : ''}`}
                        >
                          <span className="mission-row__check" aria-hidden>{mission.completed ? '✓' : '○'}</span>
                          <div className="mission-row__body">
                            <span className="mission-row__title">{mission.title}</span>
                            {isActive && (
                              <>
                                <span className="mission-row__desc">{mission.description}</span>
                                {mission.objectives?.map((obj) => (
                                  <span key={obj.id} className="mission-row__desc">
                                    {obj.done ? '✓' : '•'} {obj.label} ({obj.current}/{obj.target})
                                  </span>
                                ))}
                              </>
                            )}
                          </div>
                          <span className="mission-row__reward">+{mission.rewardXp} XP<br />+{mission.rewardRep} REP</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Mode badge */}
            <div className="mode-badge">
              <span className="mode-badge__dot" />
              RUGTOWN CITY
            </div>
          </div>
          )}

          {/* ──────────────────────────────────────────────────────
              TOP-CENTER: Camera coordinates + controls
              ────────────────────────────────────────────────────── */}
          <div className="hud-coords">
            <button
              className="coord-btn"
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out (− key)"
            >−</button>
            <span className="coord-text">
              {zoomPct}% · {camCenterX},{camCenterY}
            </span>
            <button
              className="coord-btn"
              onClick={zoomIn}
              aria-label="Zoom in"
              title="Zoom in (+ key)"
            >+</button>
            <button
              className="coord-btn coord-btn--reset"
              onClick={resetView}
              aria-label="Reset view"
              title="Reset zoom + recenter (0)"
            >⌂</button>
          </div>

          {camNeedsRecenter && (
            <button
              type="button"
              className="camera-recenter-btn"
              onClick={recenterView}
              aria-label="Recenter camera on player"
              title="Recenter camera (Space)"
              data-ui-block-camera
            >
              Recenter
            </button>
          )}

          {/* ──────────────────────────────────────────────────────
              RIGHT SIDEBAR: Minimap + Zone list
              Image 2: small map upper-right with zone dots
              Image 3: ornate gold bordered panel
              On mobile this collapses into a small toggle button.
              ────────────────────────────────────────────────────── */}
          {/* Mobile: collapsed map toggle */}
          {isMobile && !mobileMapOpen && (
            <button
              className="mobile-collapsed-btn mobile-collapsed-btn--tr"
              onClick={() => setMobileMapOpen(true)}
              aria-label="Show map"
            >🗺️</button>
          )}
          {/* Desktop: collapsed map toggle — shows only when map is hidden */}
          {!isMobile && !desktopMapOpen && (
            <button
              className="desktop-map-show-btn"
              onClick={() => setDesktopMapOpen(true)}
              aria-label="Show minimap"
              title="Show minimap"
            >🗺️</button>
          )}
          {/* Map panel — shown on mobile when open, or on desktop when not collapsed */}
          {(isMobile ? mobileMapOpen : desktopMapOpen) && (
          <div className="hud-panel hud-panel--tr">
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

            {isMobile && (
              <button
                className="mobile-panel-close"
                onClick={() => setMobileMapOpen(false)}
                aria-label="Close map"
              >✕</button>
            )}

            <div className="panel-header">
              <span className="panel-header__logo">RUGTOWN MAP</span>
              {/* Desktop hide button — Part B */}
              {!isMobile && (
                <button
                  className="desktop-map-hide-btn"
                  onClick={() => setDesktopMapOpen(false)}
                  aria-label="Hide minimap"
                  title="Hide minimap"
                >✕</button>
              )}
            </div>

            <CompactMinimap
              live={mapLive.live}
              remotes={mapLive.remotes}
              missionLandmarkId={mapLive.missionLandmarkId}
              filters={mapFilters}
              onOpenExpanded={() => setExpandedMapOpen(true)}
            />

            <div className="minimap-status">
              {nearestLandmark
                ? <>📍 <strong>{nearestLandmark.displayName}</strong></>
                : currentDistrict || 'Exploring RugTown'}
            </div>

            <div className="zone-legend zone-legend--compact">
              {minimapLandmarks.slice(0, 8).map((lm) => (
                <button
                  key={lm.id}
                  type="button"
                  className={`zone-legend-item ${nearestLandmark?.id === lm.id ? 'zone-legend-item--active' : ''}`}
                  title={lm.name}
                  data-ui-block-camera
                  onClick={() => setExpandedMapOpen(true)}
                >
                  <span className="zone-dot zone-dot--landmark" />
                  <span className="zone-name">{lm.icon}</span>
                </button>
              ))}
              <button
                type="button"
                className="zone-legend-item zone-legend-item--more"
                data-ui-block-camera
                onClick={() => setExpandedMapOpen(true)}
              >
                Full map →
              </button>
            </div>

            <div className="cam-info">
              <span>Players: {mapLive.remotes.length + 1}</span>
              <span>NPCs: {mapLive.live.npcs.length}</span>
              <span>Tap map to expand</span>
            </div>
          </div>
          )}

          <ExpandedWorldMap
            open={expandedMapOpen}
            onClose={() => {
              setExpandedMapOpen(false);
              publishMinimapUiDebug(sceneRef, null);
            }}
            live={mapLive.live}
            remotes={mapLive.remotes}
            missionLandmarkId={mapLive.missionLandmarkId}
            onCenterPlayer={() => sceneRef.current?.recenterCamera()}
            onDebugUpdate={(d) => publishMinimapUiDebug(sceneRef, d)}
            onSelectRemote={(remote) => {
              const full = onlinePlayers.find((p) => p.id === remote.id);
              const summary = full
                ? presenceToSocialSummary(full)
                : presenceToSocialSummary({
                    id: remote.id,
                    username: remote.username,
                    x: remote.x,
                    y: remote.y,
                    appearance: getCanonicalPlayerAppearance(),
                    rep: remote.rep ?? 0,
                    holderTier: remote.holderTier ?? 'None',
                  });
              setRemoteOfflineNotice(null);
              setRemoteProfile(summary);
              setRemoteProfileClosing(false);
              setExpandedMapOpen(false);
            }}
          />

          {/* ──────────────────────────────────────────────────────
              CITY CHAT — toggled from the action bar's Chat button
              ────────────────────────────────────────────────────── */}
          {isChatOpen && (
            <div className="hud-panel chat-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">CITY CHAT</span>
                <span
                  className={`conn-indicator conn-indicator--${connState}`}
                  role="status"
                  aria-live="polite"
                  title={`Realtime: ${connState}`}
                >
                  <span className="conn-dot" aria-hidden />
                  {connState === 'online' ? 'Online' : connState === 'connecting' ? 'Connecting…' : 'Offline'}
                </span>
                <button
                  className="chat-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close chat"
                >✕</button>
              </div>

              <div className="chat-log" ref={chatLogRef} aria-live="polite">
                {chatMessages.length === 0 && (
                  <div className="chat-log__empty">No messages yet. Say GM.</div>
                )}
                {chatMessages.map(m => (
                  <div
                    key={m.id}
                    className={`chat-message chat-message--${m.kind}`}
                  >
                    <span className="chat-message__sender">
                      {m.sender}
                      {m.kind === 'npc' && <span className="chat-message__npc-tag">[NPC]</span>}
                    </span>
                    <span className="chat-message__text">{m.text}</span>
                  </div>
                ))}
              </div>

              <div className="chat-input-row">
                <input
                  ref={chatInputRef}
                  className="chat-input"
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleChatInputKeyDown}
                  onFocus={() => sceneRef.current?.setKeyboardEnabled(false)}
                  onBlur={() => sceneRef.current?.setKeyboardEnabled(true)}
                  placeholder="Say something to RugTown..."
                  maxLength={140}
                  autoComplete="off"
                  aria-label="Chat message"
                />
                <button className="chat-send-btn" onClick={sendChatMessage} aria-label="Send">
                  Send
                </button>
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              QUESTS — toggled from the action bar's Quests button
              ────────────────────────────────────────────────────── */}
          {isQuestsOpen && (
            <div className="hud-panel quest-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">QUESTS</span>
                <button
                  className="quest-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close quests"
                >✕</button>
              </div>

              <div className="quest-list">
                {QUESTS.map(q => {
                  const status = questStatus[q.id];
                  return (
                    <div key={q.id} className={`quest-item quest-item--${status}`}>
                      <div className="quest-item__header">
                        <span className="quest-item__title">{q.title}</span>
                        <span className={`quest-item__badge quest-item__badge--${status}`}>
                          {status === 'claimed' ? 'Claimed' : status === 'ready' ? 'Complete!' : 'In Progress'}
                        </span>
                      </div>
                      <p className="quest-item__desc">{q.description}</p>
                      <div className="quest-item__footer">
                        <span className="quest-item__reward">+{applyHolderMultiplier(q.reward)} REP</span>
                        {status === 'ready' && (
                          <button
                            className="quest-item__claim-btn"
                            onClick={() => claimQuestReward(q.id)}
                          >
                            Claim
                          </button>
                        )}
                        {status === 'claimed' && (
                          <span className="quest-item__claimed-check">✓ Claimed</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              HOLDER STATUS — toggled from the action bar's Holder button.
              Mock/local only — no wallet connection, no Solana calls.
              ────────────────────────────────────────────────────── */}
          {isHolderOpen && (
            <div className="hud-panel holder-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">HOLDER STATUS</span>
                <button
                  className="holder-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close holder panel"
                >✕</button>
              </div>

              <div className="holder-panel__mock-tag">MOCK · DEVNET PREVIEW — no wallet connected</div>

              <div className="holder-panel__body">
                <p className="modal-text">
                  Simulate a holder tier to preview how REP rewards scale. This is a local toggle only —
                  no wallet, no real Solana data.
                </p>

                <div className="holder-tier-grid">
                  {HOLDER_TIERS.map(({ tier, multiplier }) => (
                    <button
                      key={tier}
                      className={`holder-tier-btn holder-tier-btn--${tier.toLowerCase()} ${
                        holderTier === tier ? 'holder-tier-btn--active' : ''
                      }`}
                      onClick={() => setHolderTierAndNotify(tier)}
                    >
                      <span className="holder-tier-btn__name">{tier}</span>
                      <span className="holder-tier-btn__mult">{multiplier}x REP</span>
                    </button>
                  ))}
                </div>

                {holderTier === 'Gold' && (
                  <div className="holder-vault-status">
                    🔓 Vault Access: Preview Enabled
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              TODAY'S STORY — toggled from the action bar's Story button
              (Phase 4 Event Chain System). Last 5 notable moments: an
              event going Live, or a player claiming a treasure/whale.
              Local-only, nothing persisted between sessions.
              ────────────────────────────────────────────────────── */}
          {isStoryOpen && (
            <div className="hud-panel story-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">TODAY'S STORY</span>
                <button
                  className="story-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close story log"
                >✕</button>
              </div>

              <div className="story-panel__body">
                {storyLog.length === 0 ? (
                  <p className="story-panel__empty">Nothing has happened yet — stay close to the city.</p>
                ) : (
                  <ol className="story-log-list">
                    {storyLog.map((entry, i) => (
                      <li key={entry.id} className="story-log-item">
                        <span className="story-log-item__index">{i + 1}</span>
                        <span className="story-log-item__text">{entry.text}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              LEADERBOARD — toggled from the action bar's Leaderboard
              button. Phase 2: now the real server-ranked Points leaderboard
              (get_points_leaderboard) instead of the old REP-based, NPC-
              seeded inline block — see PointsLeaderboardPanel.tsx.
              ────────────────────────────────────────────────────── */}
          <PointsLeaderboardPanel
            open={isLeaderboardOpen}
            onClose={() => setActiveAction(null)}
            playerName={playerName ?? ''}
            isGuest={!userId}
          />

          {/* Mission HQ — Government Quarter's gameplay purpose (browse daily/
              weekly missions, claim rewards, see level progress). */}
          <MissionHQPanel
            open={isMissionHQOpen}
            onClose={() => setActiveAction(null)}
            onToast={showToast}
          />

          {/* ──────────────────────────────────────────────────────
              SETTINGS — toggled from the action bar's Settings button.
              Local-only sound controls: mute + 3 volume sliders, all
              WebAudio placeholder tones (no audio files).
              ────────────────────────────────────────────────────── */}
          {isSettingsOpen && (
            <div className="hud-panel settings-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">SETTINGS</span>
                <button
                  className="settings-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close settings"
                >✕</button>
              </div>

              <div className="settings-panel__body">
                <div className={`sound-status ${soundUnlocked ? 'sound-status--ready' : 'sound-status--locked'}`} role="status">
                  {soundUnlocked
                    ? (muted ? '🔇 Sound Off' : '🔊 Sound Ready')
                    : '🔒 Click, tap, or press a key to enable sound'}
                </div>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Sound</span>
                  <button
                    className={`settings-mute-btn ${muted ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleMuted}
                    aria-pressed={!muted}
                  >
                    {muted ? '🔇 Muted' : '🔊 On'}
                  </button>
                </div>

                <button className="settings-test-sound-btn" onClick={playTestSound}>
                  🔔 Test Sound
                </button>

                <div className="settings-slider-row">
                  <label className="settings-slider-row__label" htmlFor="vol-music">Music</label>
                  <input
                    id="vol-music"
                    className="settings-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={musicVol}
                    disabled={muted}
                    onChange={(e) => handleVolumeChange('music', parseFloat(e.target.value))}
                  />
                </div>

                <div className="settings-slider-row">
                  <label className="settings-slider-row__label" htmlFor="vol-effects">Effects</label>
                  <input
                    id="vol-effects"
                    className="settings-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={effectsVol}
                    disabled={muted}
                    onChange={(e) => handleVolumeChange('effects', parseFloat(e.target.value))}
                  />
                </div>

                <p className="settings-panel__note">
                  Music streams live and shuffles as you explore. Sound unlocks
                  automatically on your first click, tap, or key press.
                </p>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Fullscreen</span>
                  <button
                    className={`settings-mute-btn ${!isFullscreen ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleFullscreen}
                    aria-pressed={isFullscreen}
                  >
                    {isFullscreen ? '⛶ On' : '⛶ Off'}
                  </button>
                </div>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Collision Debug</span>
                  <button
                    className={`settings-mute-btn ${!collisionDebugOn ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleCollisionDebug}
                    aria-pressed={collisionDebugOn}
                    title="Same toggle as the C key"
                  >
                    {collisionDebugOn ? '🟥 On' : '🟥 Off'}
                  </button>
                </div>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Asset Bounds Debug</span>
                  <button
                    className={`settings-mute-btn ${!assetBoundsDebugOn ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleAssetBoundsDebug}
                    aria-pressed={assetBoundsDebugOn}
                  >
                    {assetBoundsDebugOn ? '🟨 On' : '🟨 Off'}
                  </button>
                </div>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Asset Anchors</span>
                  <button
                    className={`settings-mute-btn ${!assetAnchorsDebugOn ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleAssetAnchorsDebug}
                    aria-pressed={assetAnchorsDebugOn}
                  >
                    {assetAnchorsDebugOn ? '📍 On' : '📍 Off'}
                  </button>
                </div>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Road Clearance Overlay</span>
                  <button
                    className={`settings-mute-btn ${!assetRoadDebugOn ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleAssetRoadDebug}
                    aria-pressed={assetRoadDebugOn}
                  >
                    {assetRoadDebugOn ? '🛣️ On' : '🛣️ Off'}
                  </button>
                </div>

                <div className="settings-mute-row">
                  <span className="settings-mute-row__label">Player Depth Layer</span>
                  <button
                    className={`settings-mute-btn ${!assetPlayerDepthDebugOn ? 'settings-mute-btn--muted' : ''}`}
                    onClick={toggleAssetPlayerDepthDebug}
                    aria-pressed={assetPlayerDepthDebugOn}
                  >
                    {assetPlayerDepthDebugOn ? '🧍 On' : '🧍 Off'}
                  </button>
                </div>

                <button className="settings-action-btn" onClick={resetView}>
                  🎯 Reset Camera
                </button>

                {/* ── Account ── shown only when signed in via Supabase ── */}
                {(walletAddress || userEmail) && (
                  <div className="settings-mute-row settings-account-row">
                    <span className="settings-account-email" title={walletAddress ?? userEmail ?? ''}>
                      {walletAddress ? shortenWalletAddress(walletAddress) : userEmail}
                    </span>
                    {onLogout && (
                      <button
                        className="settings-mute-btn settings-mute-btn--muted"
                        onClick={onLogout}
                        aria-label="Disconnect wallet and sign out"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              INVENTORY — toggled from the action bar's Inventory
              button. Items tab is flavor only; Badges unlock from the
              same local progress signals the quests already watch.
              ────────────────────────────────────────────────────── */}
          {isInventoryOpen && (
            <div className="hud-panel inventory-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">INVENTORY</span>
                <button
                  className="inventory-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close inventory"
                >✕</button>
              </div>

              <div className="inventory-tabs" role="tablist">
                {INVENTORY_TABS.map(tab => (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={inventoryTab === tab}
                    className={`inventory-tab ${inventoryTab === tab ? 'inventory-tab--active' : ''}`}
                    onClick={() => setInventoryTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {inventoryTab === 'Items' ? (
                <div className="inventory-grid">
                  {MOCK_ITEMS.map(item => (
                    <div key={item.id} className="inventory-card">
                      <span className="inventory-card__icon" aria-hidden>{item.icon}</span>
                      <span className="inventory-card__name">{item.name}</span>
                      <span className="inventory-card__desc">{item.description}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="inventory-grid">
                  {BADGES.map(badge => {
                    const unlocked = badgeStatus[badge.id] === 'unlocked';
                    return (
                      <div
                        key={badge.id}
                        className={`inventory-card ${unlocked ? 'inventory-card--unlocked' : 'inventory-card--locked'}`}
                      >
                        <span className="inventory-card__icon" aria-hidden>
                          {unlocked ? badge.icon : '🔒'}
                        </span>
                        <span className="inventory-card__name">{badge.name}</span>
                        <span className="inventory-card__desc">{badge.description}</span>
                        <span className={`inventory-card__status inventory-card__status--${unlocked ? 'unlocked' : 'locked'}`}>
                          {unlocked ? 'Unlocked' : 'Locked'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              EMOTES — toggled from the action bar's Emotes button.
              Each emote shows a speech bubble + pop animation on the
              player and logs a chat line — purely local, no NPC change.
              ────────────────────────────────────────────────────── */}
          {isEmotesOpen && (
            <div className="hud-panel emote-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">EMOTES</span>
                <button
                  className="emote-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close emotes"
                >✕</button>
              </div>

              <div className="emote-grid">
                {EMOTES.map(emote => (
                  <button
                    key={emote.id}
                    className="emote-btn"
                    onClick={() => triggerEmote(emote)}
                  >
                    <span className="emote-btn__icon" aria-hidden>{emote.icon}</span>
                    <span className="emote-btn__label">{emote.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              DISTRICT PROGRESS — toggled from the action bar's Map
              button. Local-only progression layered on top of the
              existing world; nothing is physically blocked.
              ────────────────────────────────────────────────────── */}
          {isMapOpen && (
            <div className="hud-panel district-panel">
              <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
              <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

              <div className="panel-header">
                <span className="panel-header__logo">DISTRICT PROGRESS</span>
                <button
                  className="district-panel__close"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close district progress"
                >✕</button>
              </div>

              <div className="district-list">
                {DISTRICTS.map(d => {
                  const unlocked = districtUnlocked[d.id];
                  return (
                    <div
                      key={d.id}
                      className={`district-item ${unlocked ? 'district-item--unlocked' : 'district-item--locked'}`}
                    >
                      <div className="district-item__header">
                        <span className="district-item__name">{d.name}</span>
                        <span className={`district-item__status district-item__status--${unlocked ? 'unlocked' : 'locked'}`}>
                          {unlocked ? '🔓 Unlocked' : '🔒 Locked'}
                        </span>
                      </div>
                      <p className="district-item__desc">{d.description}</p>
                      <p className="district-item__req">
                        {unlocked ? '✓' : '•'} {d.requirement}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ──────────────────────────────────────────────────────
              MISSION HUD — always-visible current level + objective
              ────────────────────────────────────────────────────── */}
          <div className="mission-hud" role="status">
            {currentLevelDef ? (
              <div className="mission-hud__inner" key={currentLevel}>
                <div className="mission-hud__top">
                  <span className="mission-hud__level">LV {currentLevelDef.id}/{LEVEL_DEFINITIONS.length}</span>
                  <span className="mission-hud__sep">·</span>
                  <span className="mission-hud__group">{currentLevelDef.group}</span>
                  <span className="mission-hud__sep">·</span>
                  <span className="mission-hud__reward">+{currentLevelDef.rewardRep} REP</span>
                </div>
                <div className="mission-hud__bottom">
                  <span className="mission-hud__title">{currentLevelDef.title}</span>
                  <span className="mission-hud__sep">—</span>
                  <span className="mission-hud__obj">{currentLevelDef.description}</span>
                  <span className="mission-hud__sep">·</span>
                  <span className="mission-hud__building">📍{currentLevelDef.buildingName}</span>
                </div>
              </div>
            ) : (
              <div className="mission-hud__top">
                <span className="mission-hud__level">LEGEND</span>
                <span className="mission-hud__sep">·</span>
                <span className="mission-hud__group">All 30 levels complete!</span>
              </div>
            )}
          </div>

          {/* ──────────────────────────────────────────────────────
              CHAT FAB — always-visible chat toggle, separate from
              the action bar so players immediately see it without
              needing to know Chat is the first item in the bar.
              ────────────────────────────────────────────────────── */}
          <button
            className={`chat-fab${isChatOpen ? ' chat-fab--active' : ''}`}
            onClick={() => {
              soundManager.play('click');
              setModalClosing(false); setModalZone(null);
              setDialogueClosing(false); setDialogue(null);
              setWhaleAlertClosing(false); setWhaleAlert(null);
              setStatueModalClosing(false); setStatueModal(null);
              setActiveAction(prev => prev === 'Chat' ? null : 'Chat');
            }}
            aria-label={isChatOpen ? 'Close city chat' : 'Open city chat'}
            title="City Chat (C)"
          >
            💬
            {chatMessages.length > 0 && !isChatOpen && (
              <span className="chat-fab__dot" aria-hidden />
            )}
          </button>

          {/* ──────────────────────────────────────────────────────
              BOTTOM ACTION BAR
              Image 2: horizontal row of icon buttons at screen bottom
              Image 3: gold-bordered dark bar, circular icon buttons
              ────────────────────────────────────────────────────── */}
          <div className="action-bar" role="toolbar" aria-label="Game actions">
            {/* Left ornament */}
            <div className="action-bar__ornament action-bar__ornament--left" aria-hidden>
              <svg viewBox="0 0 24 48" fill="none">
                <path d="M22 4 L4 24 L22 44" stroke="currentColor" strokeWidth="2" fill="none"/>
                <circle cx="22" cy="4"  r="3" fill="currentColor"/>
                <circle cx="22" cy="44" r="3" fill="currentColor"/>
              </svg>
            </div>

            {/* Action buttons */}
            {ACTION_BAR_ITEMS.map((item) => (
              <button
                key={item.label}
                className={`action-btn ${activeAction === item.label || (item.label === 'Rewards' && rewardCentreOpen) || (item.label === 'Social' && socialHubOpen) || (item.label === 'Party' && partyPanelOpen) || (item.label === 'Events' && eventCentreOpen) ? 'action-btn--active' : ''}`}
                onClick={() => {
                  soundManager.play('click');
                  setModalClosing(false);
                  setModalZone(null);
                  setDialogueClosing(false);
                  setDialogue(null);
                  setWhaleAlertClosing(false);
                  setWhaleAlert(null);
                  setStatueModalClosing(false);
                  setStatueModal(null);
                  const closeSpecial = () => {
                    setRewardCentreOpen(false);
                    setSocialHubOpen(false);
                    setPartyPanelOpen(false);
                    setEventCentreOpen(false);
                    setTournamentCentreOpen(false);
                    setGuildPanelOpen(false);
                  };
                  if (item.label === 'Rewards') {
                    setActiveAction(null);
                    closeSpecial();
                    setRewardCentreOpen((v) => !v);
                    return;
                  }
                  if (item.label === 'Social') {
                    setActiveAction(null);
                    closeSpecial();
                    setSocialHubOpen((v) => !v);
                    return;
                  }
                  if (item.label === 'Party') {
                    setActiveAction(null);
                    closeSpecial();
                    setPartyPanelOpen((v) => !v);
                    return;
                  }
                  if (item.label === 'Events') {
                    setActiveAction(null);
                    closeSpecial();
                    setEventCentreOpen((v) => !v);
                    return;
                  }
                  closeSpecial();
                  const willOpen = activeAction !== item.label;
                  setActiveAction(prev => prev === item.label ? null : item.label);
                  if (willOpen) {
                    if (item.label === 'Leaderboard') completeLevelIfMatches('open_leaderboard');
                    if (item.label === 'Inventory')   completeLevelIfMatches('open_inventory');
                    if (item.label === 'Holder')      completeLevelIfMatches('open_holder');
                  }
                }}
                aria-label={item.label}
                aria-pressed={
                  item.label === 'Rewards'
                    ? rewardCentreOpen
                    : item.label === 'Social'
                      ? socialHubOpen
                      : item.label === 'Party'
                        ? partyPanelOpen
                        : item.label === 'Events'
                          ? eventCentreOpen
                          : activeAction === item.label
                }
                title={`${item.label}${item.key ? ` (${item.key})` : ''}`}
              >
                {/* Shimmer on hover */}
                <span className="action-btn__shimmer" aria-hidden />
                {/* Corner ornaments for active state */}
                {(activeAction === item.label || (item.label === 'Social' && socialHubOpen) || (item.label === 'Party' && partyPanelOpen) || (item.label === 'Events' && eventCentreOpen)) && <>
                  <span className="action-btn__corner action-btn__corner--tl" aria-hidden>◆</span>
                  <span className="action-btn__corner action-btn__corner--tr" aria-hidden>◆</span>
                </>}
                <span className="action-btn__icon" aria-hidden>{item.icon}</span>
                <span className="action-btn__label">{item.label}</span>
                {item.label === 'Social' && unreadDmCount > 0 && (
                  <span className="social-unread-badge social-unread-badge--hud" aria-label={`${unreadDmCount} unread`}>
                    {unreadDmCount > 9 ? '9+' : unreadDmCount}
                  </span>
                )}
                {item.label === 'Party' && partyUnread > 0 && (
                  <span className="social-unread-badge social-unread-badge--hud" aria-label={`${partyUnread} party unread`}>
                    {partyUnread > 9 ? '9+' : partyUnread}
                  </span>
                )}
                {item.key && (
                  <span className="action-btn__key" aria-hidden>{item.key}</span>
                )}
              </button>
            ))}

            {/* Right ornament */}
            <div className="action-bar__ornament action-bar__ornament--right" aria-hidden>
              <svg viewBox="0 0 24 48" fill="none">
                <path d="M2 4 L20 24 L2 44" stroke="currentColor" strokeWidth="2" fill="none"/>
                <circle cx="2" cy="4"  r="3" fill="currentColor"/>
                <circle cx="2" cy="44" r="3" fill="currentColor"/>
              </svg>
            </div>
          </div>

          {/* ──────────────────────────────────────────────────────
              MOBILE TOUCH CONTROLS — joystick (movement), interact
              button (same effect as E), and a zoom/reset cluster.
              Desktop keyboard/mouse controls are untouched; these only
              render below the ≤600px breakpoint.
              ────────────────────────────────────────────────────── */}
          {isMobile && (
            <div className="mobile-controls">
              <div
                className="mobile-joystick"
                ref={joystickBaseRef}
                onPointerDown={handleJoystickPointerDown}
                onPointerMove={handleJoystickPointerMove}
                onPointerUp={handleJoystickPointerUp}
                onPointerCancel={handleJoystickPointerUp}
                role="application"
                aria-label="Move"
              >
                <div
                  className="mobile-joystick__knob"
                  style={{ transform: `translate(${joystickKnob.x}px, ${joystickKnob.y}px)` }}
                />
              </div>

              <div className="mobile-action-cluster">
                <button className="mobile-zoom-btn" onClick={zoomOut} aria-label="Zoom out">−</button>
                <button className="mobile-zoom-btn" onClick={zoomIn} aria-label="Zoom in">+</button>
                <button className="mobile-zoom-btn mobile-zoom-btn--reset" onClick={resetView} aria-label="Reset camera">⌂</button>
                <button
                  className="mobile-interact-btn"
                  onClick={handleMobileInteract}
                  aria-label={activeInteract?.mobileLabel ?? 'Interact'}
                  data-ui-block-camera
                  style={{ display: (activeInteract || interiorPrompt) ? undefined : 'none' }}
                >
                  <span className="mobile-interact-btn__key">E</span>
                  <span className="mobile-interact-btn__label">
                    {interiorPrompt
                      ? (interiorPrompt.kind === 'exit' ? 'Leave' : 'Inspect')
                      : (activeInteract?.mobileLabel ?? 'Interact')}
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* Controls hint — fades after a few seconds */}
          <div className="controls-hint" role="note">
            <span>WASD / ↑↓←→  move</span>
            <span className="hint-sep">·</span>
            <span>+ / −  zoom</span>
            <span className="hint-sep">·</span>
            <span>Scroll wheel  zoom</span>
            <span className="hint-sep">·</span>
            <span>⌂  reset camera</span>
            <span className="hint-sep">·</span>
            <span>Click map  teleport</span>
          </div>

          {/* Interaction prompt — landmark zone takes priority over an NPC,
              which takes priority over the Treasure Hunt chest / Whale
              Alert marker, which takes priority over a Hall of Fame statue
              (matches WorldScene's own updateZoneProximity/
              updateNpcProximity/updateTreasureProximity/updateWhaleProximity/
              updateStatueProximity priority order — treasure and whale can
              never both be active since only one event is ever Live at
              once). Hidden while any other overlay (modal, dialogue, or an
              action-bar panel) is already on screen so it can't overlap
              the bottom-center panels (Holder/Leaderboard/Settings/etc). */}
          {!modalZone && !dialogue && !activeAction && !whaleAlert && !statueModal && !statusModal &&
            (activeInteract || nearDoor || nearZone || nearNpc || nearTreasure || nearWhale || nearStatue || nearTownCrier || interiorPrompt) && (
            <div
              className={`zone-prompt${(activeInteract?.id === 'fountain' || nearZone?.id === 'fountain') && !fountainClaimed ? ' zone-prompt--fountain-highlight' : ''}${activeInteract?.access === 'locked' || activeInteract?.access === 'coming_soon' ? ' zone-prompt--locked' : ''}`}
              role="status"
              data-ui-block-camera
            >
              {!isMobile && <span className="zone-prompt__key">E</span>}
              <span className="zone-prompt__text">
                {isMobile && activeInteract?.mobileLabel
                  ? activeInteract.mobileLabel
                  : interiorPrompt
                  ? `Press E to ${interiorPrompt.kind === 'exit' ? 'leave' : 'inspect'} — ${interiorPrompt.label}`
                  : (activeInteract?.id === 'fountain' && !fountainClaimed)
                    ? 'Press E to Gather — Spring Water'
                  : activeInteract?.desktopPrompt
                    ? activeInteract.desktopPrompt
                  : nearDoor
                  ? (nearDoor.access === 'open'
                      ? `Press E to enter — ${nearDoor.name}`
                      : nearDoor.access === 'coming_soon'
                        ? `${nearDoor.name} — Coming Soon`
                        : `${nearDoor.name} — Locked`)
                  : nearTownCrier
                  ? 'Press E to talk — Town Crier'
                  : nearZone
                  ? (nearZone.id === 'fountain' && !fountainClaimed
                      ? `Press E to Gather — Spring Water`
                      : `Press E to Inspect — ${nearZone.name}`)
                  : nearNpc
                  ? `Press E to talk — ${nearNpc.name}`
                  : nearTreasure
                  ? 'Press E to open treasure'
                  : nearWhale
                  ? 'Press E to inspect whale'
                  : 'Press E to inspect statue'}
              </span>
            </div>
          )}

        </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════
          INTERACTION ZONE MODAL — polished black/gold, per-zone content
          ══════════════════════════════════════════════════════════ */}
      {modalZone && (
        <div
          className={`modal-overlay ${modalClosing ? 'modal-overlay--closing' : ''}`}
          onClick={requestCloseModal}
        >
          <div
            className={`modal-panel ${modalZone === 'market' ? 'modal-panel--market' : ''} ${modalZone === 'notice' ? 'modal-panel--notice' : ''} ${modalZone === 'alpha' ? 'modal-panel--alpha' : ''} ${modalClosing ? 'modal-panel--closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>
            <span className="modal-panel__shimmer" aria-hidden />

            <div className="modal-header">
              <span className="modal-header__icon" aria-hidden>
                {getWorldObject(modalZone)?.futureIcon ?? '✦'}
              </span>
              <div className="modal-header__titles">
                <span className="modal-header__title">{ZONE_INFO[modalZone]?.title ?? modalZone}</span>
                <span className="modal-header__sub">{ZONE_INFO[modalZone]?.sub ?? ''}</span>
              </div>
              <button className="modal-close" onClick={requestCloseModal} aria-label="Close">✕</button>
            </div>

            <div className={`modal-body ${modalZone === 'market' ? 'modal-body--market' : ''} ${modalZone === 'notice' ? 'modal-body--notice' : ''} ${modalZone === 'alpha' ? 'modal-body--alpha' : ''}`}>
              {renderModalBody(modalZone)}
            </div>
          </div>
        </div>
      )}

      {statusModal && (
        <div
          className={`modal-overlay ${statusModalClosing ? 'modal-overlay--closing' : ''}`}
          onClick={requestCloseStatusModal}
        >
          <div
            className={`modal-panel ${statusModalClosing ? 'modal-panel--closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>
            <span className="modal-panel__shimmer" aria-hidden />

            <div className="modal-header">
              <span className="modal-header__icon" aria-hidden>
                {statusModal.mode === 'coming_soon' ? '🏟️' : statusModal.mode === 'locked' ? '🔒' : '✦'}
              </span>
              <div className="modal-header__titles">
                <span className="modal-header__title">{statusModal.title}</span>
                <span className="modal-header__sub">
                  {statusModal.mode === 'coming_soon'
                    ? 'Coming Soon'
                    : statusModal.mode === 'locked'
                      ? 'Locked'
                      : 'Interior'}
                </span>
              </div>
              <button className="modal-close" onClick={requestCloseStatusModal} aria-label="Close">✕</button>
            </div>

            <div className="modal-body">
              <p className="modal-text">{statusModal.text}</p>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          NPC DIALOGUE — same black/gold style, name + one line only
          ══════════════════════════════════════════════════════════ */}
      {dialogue && (
        <div
          className={`modal-overlay ${dialogueClosing ? 'modal-overlay--closing' : ''}`}
          onClick={requestCloseDialogue}
        >
          <div
            className={`modal-panel ${dialogueClosing ? 'modal-panel--closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>
            <span className="modal-panel__shimmer" aria-hidden />

            <div className="modal-header">
              <span className="modal-header__icon" aria-hidden>💬</span>
              <div className="modal-header__titles">
                <span className="modal-header__title">{dialogue.npcName}</span>
                <span className="modal-header__sub">NPC · RugTown Citizen</span>
              </div>
              <button className="modal-close" onClick={requestCloseDialogue} aria-label="Close">✕</button>
            </div>

            <div className="modal-body">
              <p className="modal-text">&ldquo;{dialogue.line}&rdquo;</p>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          WHALE ALERT MODAL — same black/gold style as the landmark
          modal/NPC dialogue above. Everything shown is clearly fake/
          local flavor data generated by WorldScene at inspection time —
          no real wallet, chain, or Solana connection.
          ══════════════════════════════════════════════════════════ */}
      {whaleAlert && (
        <div
          className={`modal-overlay ${whaleAlertClosing ? 'modal-overlay--closing' : ''}`}
          onClick={requestCloseWhaleAlert}
        >
          <div
            className={`modal-panel ${whaleAlertClosing ? 'modal-panel--closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>
            <span className="modal-panel__shimmer" aria-hidden />

            <div className="modal-header">
              <span className="modal-header__icon" aria-hidden>🐳</span>
              <div className="modal-header__titles">
                <span className="modal-header__title">Whale Alert</span>
                <span className="modal-header__sub">DEVNET · MOCK DATA</span>
              </div>
              <button className="modal-close" onClick={requestCloseWhaleAlert} aria-label="Close">✕</button>
            </div>

            <div className="modal-body">
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Wallet</span>
                <span className="whale-alert-row__value whale-alert-row__value--mono">{whaleAlert.wallet}</span>
              </div>
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Buy Amount</span>
                <span className="whale-alert-row__value">{whaleAlert.buySol} SOL</span>
              </div>
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Token</span>
                <span className="whale-alert-row__value">{whaleAlert.tokenSymbol}</span>
              </div>
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Risk Level</span>
                <span className={`whale-alert-risk whale-alert-risk--${whaleAlert.riskLevel.toLowerCase()}`}>
                  {whaleAlert.riskLevel}
                </span>
              </div>
              <div className="whale-alert-row whale-alert-row--reward">
                <span className="whale-alert-row__label">Reward</span>
                <span className="whale-alert-row__value whale-alert-row__value--gold">{whaleAlert.rewardLabel}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          HALL OF FAME STATUE MODAL — same black/gold style as the
          others. Rank/name/REP come straight from the same leaderboard
          data the Leaderboard panel uses; title/flavor are rank-based
          (req. 12: no real users, nothing tied to a specific identity).
          ══════════════════════════════════════════════════════════ */}
      {/* ── Remote player social card (Phase 10E/10F) ─────────────────── */}
      {remoteProfile && (
        <SocialPlayerCard
          player={remoteProfile}
          closing={remoteProfileClosing}
          friendship={remoteFriendship}
          offlineNotice={remoteOfflineNotice}
          isGuestViewer={!userId}
          canMessage={!!userId && !remoteProfile.isGuest && !remoteFriendship?.blocked}
          onClose={closeRemoteProfile}
          onWave={waveAtRemotePlayer}
          onMessage={() => openDirectMessage(remoteProfile)}
          onAddFriend={async () => {
            const res = await socialService.sendFriendRequest(remoteProfile.playerId);
            showToast(res.message ?? '');
            setRemoteFriendship(await socialService.getFriendshipState(remoteProfile.playerId));
          }}
          onInviteParty={async () => {
            if (!userId || remoteProfile.isGuest) {
              showToast('Sign in required for party invites');
              return;
            }
            const res = await partyService.invitePlayer(remoteProfile.playerId);
            showToast(res.message ?? (res.ok ? 'Party invite sent' : 'Invite failed'));
          }}
          onAcceptFriend={async () => {
            const incoming = socialService.getIncomingRequests().find(
              (r) => r.senderId === remoteProfile.playerId,
            );
            if (!incoming) {
              showToast('No pending request found');
              return;
            }
            const res = await socialService.respondToFriendRequest(incoming.id, true);
            showToast(res.message ?? '');
            setRemoteFriendship(await socialService.getFriendshipState(remoteProfile.playerId));
          }}
          onBlock={async () => {
            const res = await socialService.blockPlayer(remoteProfile.playerId);
            showToast(res.message ?? '');
            closeRemoteProfile();
          }}
          onReport={() => {
            setReportPlayer({
              playerId: remoteProfile.playerId,
              username: remoteProfile.username,
            });
          }}
          onViewProfile={() => {
            // Public summary already shown; server profile may add bio/title.
            void socialService.getPublicProfile(remoteProfile.playerId).then((p) => {
              if (p?.bio) showToast(`Bio: ${p.bio}`);
              else if (p?.restricted) showToast('Profile is private');
            });
          }}
        />
      )}

      {progression && (
        <PlayerProfilePanel
          open={profilePanelOpen}
          onClose={() => setProfilePanelOpen(false)}
          progression={progression}
          username={playerName || 'DegenExplorer'}
          holderTier={holderTier}
          onEquipTitle={(id) => progressionService.equipTitle(id)}
        />
      )}

      <LevelUpToast
        notice={activeLevelUp}
        onDismiss={() => setActiveLevelUp(null)}
      />

      <RewardCentrePanel
        open={rewardCentreOpen}
        onClose={() => setRewardCentreOpen(false)}
        isGuest={!userId}
        onToast={(text) => showToast(text)}
        onOpenOps={() => {
          setRewardCentreOpen(false);
          setRewardOpsOpen(true);
        }}
        onOpenAchievements={() => {
          setRewardCentreOpen(false);
          setAchievementCentreOpen(true);
        }}
      />

      <RewardOperationsPanel
        open={rewardOpsOpen}
        onClose={() => setRewardOpsOpen(false)}
        onToast={(text) => showToast(text)}
      />

      <AchievementCentrePanel
        open={achievementCentreOpen}
        onClose={() => setAchievementCentreOpen(false)}
        isGuest={!userId}
        onToast={(text) => showToast(text)}
        onOpenTitles={() => {
          setAchievementCentreOpen(false);
          setTitleLockerOpen(true);
        }}
        onOpenSeasonPass={() => {
          setAchievementCentreOpen(false);
          setSeasonPassOpen(true);
        }}
      />

      <TitleLockerPanel
        open={titleLockerOpen}
        onClose={() => setTitleLockerOpen(false)}
        isGuest={!userId}
        onToast={(text) => showToast(text)}
      />

      <SeasonPassPanel
        open={seasonPassOpen}
        onClose={() => setSeasonPassOpen(false)}
        isGuest={!userId}
        onToast={(text) => showToast(text)}
      />

      {dmRecipient && (
        <DirectMessagePanel
          recipient={dmRecipient}
          closing={dmClosing}
          isGuest={!userId}
          userId={userId}
          onClose={closeDirectMessage}
          onToast={(text) => showToast(text)}
          onReportMessage={(id) => setReportMessageId(id)}
          onBlock={async (playerId) => {
            const res = await socialService.blockPlayer(playerId);
            showToast(res.message ?? '');
            closeDirectMessage();
          }}
        />
      )}

      <SocialHubPanel
        open={socialHubOpen}
        isGuest={!userId}
        unreadDmCount={unreadDmCount}
        onClose={() => setSocialHubOpen(false)}
        onToast={(text) => showToast(text)}
        onOpenConversation={openDirectMessageById}
        onOpenModeration={() => {
          setSocialHubOpen(false);
          setModerationOpen(true);
        }}
        onOpenGuild={() => {
          setSocialHubOpen(false);
          setGuildPanelOpen(true);
        }}
      />

      <PartyPanel
        open={partyPanelOpen}
        isGuest={!userId}
        onClose={() => setPartyPanelOpen(false)}
        onToast={(text) => showToast(text)}
      />

      <WorldEventCentrePanel
        open={eventCentreOpen}
        isGuest={!userId}
        onClose={() => setEventCentreOpen(false)}
        onToast={(text) => showToast(text)}
      />

      <TournamentCentrePanel
        open={tournamentCentreOpen}
        isGuest={!userId}
        onClose={() => setTournamentCentreOpen(false)}
        onToast={(text) => showToast(text)}
      />

      <GuildPanel
        open={guildPanelOpen}
        isGuest={!userId}
        onClose={() => setGuildPanelOpen(false)}
        onToast={(text) => showToast(text)}
      />

      <RugTownGuildPanel
        open={rugtownGuildOpen}
        playerLevel={progression?.level ?? currentLevel}
        playerRep={rep}
        onClose={() => setRugtownGuildOpen(false)}
        onRepAwarded={(amount) => setRep((r) => r + amount)}
      />

      <QuestArchivePanel
        open={vaultPanelOpen}
        onClose={() => setVaultPanelOpen(false)}
      />

      <ModerationOperationsPanel
        open={moderationOpen}
        onClose={() => setModerationOpen(false)}
        onToast={(text) => showToast(text)}
      />

      {reportPlayer && (
        <ReportPlayerDialog
          open
          playerId={reportPlayer.playerId}
          username={reportPlayer.username}
          onClose={() => setReportPlayer(null)}
          onToast={(text) => showToast(text)}
        />
      )}

      {reportMessageId && (
        <ReportMessageDialog
          open
          messageId={reportMessageId}
          onClose={() => setReportMessageId(null)}
          onToast={(text) => showToast(text)}
        />
      )}

      {statueModal && (
        <div
          className={`modal-overlay ${statueModalClosing ? 'modal-overlay--closing' : ''}`}
          onClick={requestCloseStatueModal}
        >
          <div
            className={`modal-panel ${statueModalClosing ? 'modal-panel--closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
            <span className="panel-corner panel-corner--br" aria-hidden>◆</span>
            <span className="modal-panel__shimmer" aria-hidden />

            <div className="modal-header">
              <span className="modal-header__icon" aria-hidden>🏛️</span>
              <div className="modal-header__titles">
                <span className="modal-header__title">
                  #{statueModal.rank} {statueModal.name}{statueModal.isPlayer ? ' (You)' : ''}
                </span>
                <span className="modal-header__sub">
                  {statueModal.isPlayer ? 'Hall of Fame Statue' : 'Hall of Fame Statue · RugTown Citizen'}
                </span>
              </div>
              <button className="modal-close" onClick={requestCloseStatueModal} aria-label="Close">✕</button>
            </div>

            <div className="modal-body">
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Rank</span>
                <span className={`statue-rank-badge statue-rank-badge--${statueModal.rank}`}>#{statueModal.rank}</span>
              </div>
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Name</span>
                <span className="whale-alert-row__value">{statueModal.name}</span>
              </div>
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">REP</span>
                <span className="whale-alert-row__value whale-alert-row__value--gold">{statueModal.rep.toLocaleString()}</span>
              </div>
              <div className="whale-alert-row">
                <span className="whale-alert-row__label">Title</span>
                <span className="whale-alert-row__value">{STATUE_RANK_FLAVOR[statueModal.rank]?.title ?? 'RugTown Citizen'}</span>
              </div>
              <p className="modal-text statue-modal__flavor">
                &ldquo;{STATUE_RANK_FLAVOR[statueModal.rank]?.flavor ?? 'A name RugTown won\'t soon forget.'}&rdquo;
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Brief gold pulse across the whole screen when a reward is claimed */}
      {rewardFlash > 0 && (
        <div
          key={rewardFlash}
          className="reward-flash"
          aria-hidden
          onAnimationEnd={() => setRewardFlash(0)}
        />
      )}

      {/* Global notification queue — one banner at a time, FIFO, ~15s gap.
          Every system (mayor, whale, treasure, crier, badge, level, REP,
          event, district, system) enqueues into it; this renders the single
          currently-visible one. See src/lib/notificationQueue.ts. */}
      <NotificationBanner />

      {/* ══════════════════════════════════════════════════════════
          EVENT HUD — Phase 2 Event Engine. Read-only: WorldScene's
          EventManager owns all real lifecycle state, this just mirrors
          the registry into the banner/pin below. Visible across every
          non-idle phase (countdown/announcement/live/completed/cooldown).
          ══════════════════════════════════════════════════════════ */}
      {currentEvent && eventPhase !== 'idle' && !eventBannerDismissed && (
        <div className="event-hud" aria-live="polite">
          <div
            className={`event-banner ${
              currentEvent.rarity === 'rare' || currentEvent.rarity === 'legendary' ? 'event-banner--pulse' : ''
            }`}
          >
            <div className="event-banner__row event-banner__row--top">
              <span className={`event-banner__rarity event-banner__rarity--${currentEvent.rarity}`}>
                {currentEvent.rarity}
              </span>
              <span className="event-banner__title">{currentEvent.title}</span>
              <span className="event-banner__phase">{EVENT_PHASE_LABELS[eventPhase]}</span>
              <button
                className="event-banner__close"
                onClick={() => setEventBannerDismissed(true)}
                aria-label="Dismiss event banner"
                title="Dismiss"
              >✕</button>
            </div>
            <div className="event-banner__row event-banner__row--meta">
              <span className="event-banner__meta">📍 {currentEvent.location.displayName}</span>
              <span className="event-banner__meta-sep" aria-hidden>·</span>
              <span className="event-banner__meta">🎁 {currentEvent.reward.label}</span>
              {eventTimeRemaining > 0 && (
                <>
                  <span className="event-banner__meta-sep" aria-hidden>·</span>
                  <span className="event-banner__meta event-banner__meta--time">
                    ⏱ {formatEventTime(eventTimeRemaining)}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Small pinned indicator — stays up the whole time the event
              is Live, distinct from (and smaller than) the banner above. */}
          {eventPhase === 'live' && (
            <div className="event-live-pin">
              <span className="event-live-pin__dot" aria-hidden />
              <span className="event-live-pin__label">LIVE</span>
              <span className="event-live-pin__title">{currentEvent.title}</span>
              {eventTimeRemaining > 0 && (
                <span className="event-live-pin__time">{formatEventTime(eventTimeRemaining)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mayor announcements now flow through the global notification queue
          (enqueued on the event's "announcement" phase) so they never
          overlap other alerts — see NotificationBanner above. */}

      {/* ══════════════════════════════════════════════════════════
          FIRST-MINUTE ONBOARDING PANEL
          Shown until the player claims fountain REP or dismisses it.
          Small, corner-pinned, non-blocking.
          ══════════════════════════════════════════════════════════ */}
      {ready && !onboardingDone && (
        <div className="onboarding-panel" role="complementary" aria-label="Getting started">
          <button
            className="onboarding-dismiss"
            onClick={() => setOnboardingDone(true)}
            aria-label="Dismiss onboarding"
            title="Dismiss"
          >✕</button>

          <div className="onboarding-title">Welcome to RugTown</div>

          <ol className="onboarding-steps">
            <li>{isMobile ? 'Use joystick to move' : 'Use WASD to move'}</li>
            <li>{isMobile ? 'Tap E to interact' : 'Press E to interact'}</li>
            <li>Walk to the <span className="onboarding-highlight">⛲ Spawn Fountain</span></li>
            <li>Press E to claim your first REP</li>
          </ol>
        </div>
      )}

      {/* ── 15-second idle hint ── */}
      {ready && !onboardingDone && idleHintVisible && !fountainClaimed && (
        <div className="idle-hint" role="status" aria-live="polite">
          <span className="idle-hint__icon" aria-hidden>✦</span>
          Try walking to the glowing fountain
        </div>
      )}
    </div>
  );
}
