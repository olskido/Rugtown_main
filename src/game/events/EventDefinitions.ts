import type { EventDefinition } from './EventTypes';

/*
  EventDefinitions.ts
  ────────────────────
  The sample events for Phase 2 (10 original + Rug Warning, added in
  Phase 4 as a chain target for Market Crash — see chainOptions below).
  Every field EventManager/WorldScene need is here — nothing
  event-specific lives in the engine itself. Adding another event later
  means adding one more entry to this array; no other file needs to change.

  Local-only, no Solana, no real money — rewards are REP/badge/cosmetic/
  multiplier flavor exactly like the rest of RugTown's mock economy.

  Event chains (Phase 4): `chainOptions` lists possible follow-up events,
  each with its own independent probability — see EventChainOption in
  EventTypes.ts and EventManager.pickChainFollowUp() for exactly how
  they're rolled. Not every event needs one; most still resolve to a
  normal random next event.
*/

export const EVENT_DEFINITIONS: EventDefinition[] = [
  {
    id: 'whale-alert',
    title: 'Whale Alert',
    description: 'A massive wallet just surfaced near Whale Tower. Everyone wants to know what it does next.',
    rarity: 'rare',
    duration: 45000,
    reward: { type: 'rep', amount: 15, label: '+15 REP for catching the whale live' },
    location: { landmarkId: 'whale', displayName: 'Whale Tower' },
    dialogue: [
      { phase: 'announcement', text: 'Something big just moved near Whale Tower...' },
      { phase: 'live', text: 'Everyone is watching Whale Tower right now.' },
      { phase: 'completed', text: 'The whale went quiet again. For now.' },
    ],
    weatherOverride: null,
    musicOverride: 'tense',
    citizenBehaviour: { mode: 'gather', citizenCount: 10 },
    chainOptions: [
      { id: 'treasure-hunt', probability: 0.35 },
      { id: 'market-pump', probability: 0.25 },
      { id: 'mayor-speech', probability: 0.2 },
    ],
  },
  {
    id: 'treasure-hunt',
    title: 'Treasure Hunt',
    description: 'Rumor has it something valuable is hidden somewhere in RugTown. First to find it wins.',
    rarity: 'epic',
    duration: 90000,
    reward: { type: 'rep', amount: 25, label: '+25 REP to whoever finds it first' },
    location: { landmarkId: null, displayName: 'Somewhere in RugTown' },
    dialogue: [
      { phase: 'announcement', text: "There's a rumor about hidden REP somewhere in town..." },
      { phase: 'live', text: 'The treasure hunt is on — keep your eyes open.' },
      { phase: 'completed', text: 'The hunt is over. Did anyone actually find it?' },
    ],
    weatherOverride: null,
    musicOverride: 'upbeat',
    citizenBehaviour: { mode: 'gather', citizenCount: 6 },
    phaseTimingOverrides: { countdown: 20000 },
    chainOptions: [
      { id: 'fireworks', probability: 0.35 },
      { id: 'double-rep', probability: 0.25 },
      { id: 'mayor-speech', probability: 0.2 },
    ],
  },
  {
    id: 'rain',
    title: 'Rain',
    description: 'Clouds roll in over RugTown. Purely atmospheric — no reward, just weather.',
    rarity: 'common',
    duration: 60000,
    reward: { type: 'none', label: 'No reward — just weather' },
    location: { landmarkId: null, displayName: 'All of RugTown' },
    dialogue: [
      { phase: 'announcement', text: 'Looks like rain is coming in.' },
      { phase: 'live', text: 'Stay dry out there.' },
      { phase: 'completed', text: 'The rain cleared up.' },
    ],
    weatherOverride: 'rain',
    musicOverride: 'calm',
    citizenBehaviour: { mode: 'none' },
  },
  {
    id: 'market-pump',
    title: 'Market Pump',
    description: 'Meme Market is heating up fast. Degens are piling in.',
    rarity: 'uncommon',
    duration: 40000,
    reward: { type: 'multiplier', amount: 1.5, label: '1.5x REP from Meme Market activity' },
    location: { landmarkId: 'market', displayName: 'Meme Market' },
    dialogue: [
      { phase: 'announcement', text: 'Volume is spiking at Meme Market.' },
      { phase: 'live', text: 'Meme Market is pumping — degens are piling in.' },
      { phase: 'completed', text: 'The pump cooled off. Hope someone took profit.' },
    ],
    weatherOverride: null,
    musicOverride: 'upbeat',
    citizenBehaviour: { mode: 'gather', citizenCount: 8 },
    chainOptions: [
      { id: 'dance-festival', probability: 0.3 },
    ],
  },
  {
    id: 'market-crash',
    title: 'Market Crash',
    description: "Meme Market just took a hit. It's red candles as far as the eye can see.",
    rarity: 'uncommon',
    duration: 40000,
    reward: { type: 'none', label: 'Survive the dip' },
    location: { landmarkId: 'market', displayName: 'Meme Market' },
    dialogue: [
      { phase: 'announcement', text: 'Something is wrong at Meme Market.' },
      { phase: 'live', text: "It's all red candles at Meme Market right now." },
      { phase: 'completed', text: 'Meme Market is stabilizing. Barely.' },
    ],
    weatherOverride: null,
    musicOverride: 'tense',
    citizenBehaviour: { mode: 'gather', citizenCount: 8 },
    chainOptions: [
      { id: 'rug-warning', probability: 0.35 },
      { id: 'mayor-speech', probability: 0.25 },
    ],
  },
  {
    id: 'rug-warning',
    title: 'Rug Warning',
    description: 'Suspicious wallet activity near Rug Alley. Citizens are on edge.',
    rarity: 'uncommon',
    duration: 35000,
    reward: { type: 'none', label: 'Stay alert, stay safe' },
    location: { landmarkId: null, displayName: 'Rug Alley' },
    dialogue: [
      { phase: 'announcement', text: 'Rug warning detected near Rug Alley.' },
      { phase: 'live', text: 'Liquidity just vanished near Rug Alley — be careful.' },
      { phase: 'completed', text: 'Things have gone quiet near Rug Alley again.' },
    ],
    weatherOverride: null,
    musicOverride: 'tense',
    // Deliberately 'none' — a danger warning isn't something citizens
    // walk toward, unlike a festival or a sighting.
    citizenBehaviour: { mode: 'none' },
  },
  {
    id: 'mayor-speech',
    title: 'Mayor Speech',
    description: 'The Mayor of RugTown is making an announcement at the Notice Board.',
    rarity: 'rare',
    duration: 50000,
    reward: { type: 'badge', label: 'Civic Listener badge' },
    location: { landmarkId: 'notice', displayName: 'Notice Board' },
    dialogue: [
      { phase: 'announcement', text: 'The Mayor is gathering everyone at the Notice Board.' },
      { phase: 'live', text: 'The Mayor is speaking. Crowd is listening.' },
      { phase: 'completed', text: 'The speech wrapped up. RugTown carries on.' },
    ],
    weatherOverride: null,
    musicOverride: null,
    citizenBehaviour: { mode: 'gather', citizenCount: 14 },
  },
  {
    id: 'dance-festival',
    title: 'Dance Festival',
    description: 'A spontaneous festival breaks out at the Park. Citizens are showing up to dance.',
    rarity: 'epic',
    duration: 75000,
    reward: { type: 'cosmetic', label: 'Festival Glow emote (unlocks in a future update)' },
    location: { landmarkId: 'park', displayName: 'Park Entrance' },
    dialogue: [
      { phase: 'announcement', text: 'Music is starting to play near the Park.' },
      { phase: 'live', text: 'The Dance Festival is in full swing at the Park.' },
      { phase: 'completed', text: 'The festival wound down. What a night.' },
    ],
    weatherOverride: null,
    musicOverride: 'festive',
    citizenBehaviour: { mode: 'gather', citizenCount: 16 },
  },
  {
    id: 'hidden-merchant',
    title: 'Hidden Merchant',
    description: 'A mysterious merchant has set up near the Coffee Shop — gone as quickly as they appeared.',
    rarity: 'legendary',
    duration: 60000,
    reward: { type: 'badge', label: 'Found the Hidden Merchant' },
    location: { landmarkId: 'coffee', displayName: 'Coffee Shop' },
    dialogue: [
      { phase: 'announcement', text: 'Someone unfamiliar was spotted near the Coffee Shop.' },
      { phase: 'live', text: 'A hidden merchant is here. They might not stick around long.' },
      { phase: 'completed', text: 'The merchant is gone, just like that.' },
    ],
    weatherOverride: null,
    musicOverride: null,
    // Deliberately 'none' — a merchant that's "hidden" shouldn't be
    // given away by a crowd of citizens all walking toward it.
    citizenBehaviour: { mode: 'none' },
    phaseTimingOverrides: { countdown: 25000, announcement: 4000 },
  },
  {
    id: 'fireworks',
    title: 'Fireworks',
    description: 'Fireworks light up the sky over the Spawn Fountain.',
    rarity: 'rare',
    duration: 30000,
    reward: { type: 'none', label: 'Just a show' },
    location: { landmarkId: 'fountain', displayName: 'Spawn Fountain' },
    dialogue: [
      { phase: 'announcement', text: 'Something is being set up at the Fountain.' },
      { phase: 'live', text: 'Fireworks are going off over the Fountain!' },
      { phase: 'completed', text: 'The fireworks show is over.' },
    ],
    weatherOverride: null,
    musicOverride: 'festive',
    citizenBehaviour: { mode: 'gather', citizenCount: 12 },
  },
  {
    id: 'fountain-gathering',
    title: 'Fountain Gathering',
    description: 'Citizens gather at Spring Water. Interact at the fountain to participate.',
    rarity: 'common',
    duration: 45000,
    reward: { type: 'rep', amount: 8, label: '+8 REP for joining the gathering' },
    location: { landmarkId: 'fountain', displayName: 'Spring Water' },
    dialogue: [
      { phase: 'announcement', text: 'People are meeting at Spring Water.' },
      { phase: 'live', text: 'The fountain crowd is live — press E to take part.' },
      { phase: 'completed', text: 'The gathering thinned out.' },
    ],
    weatherOverride: null,
    musicOverride: 'calm',
    citizenBehaviour: { mode: 'gather', citizenCount: 10 },
  },
  {
    id: 'alpha-leak',
    title: 'Alpha Leak',
    description: 'A rumour leaks from Alpha Lounge. Confirm it on site — idle watching pays nothing.',
    rarity: 'rare',
    duration: 50000,
    reward: { type: 'rep', amount: 12, label: '+12 REP for confirming the leak' },
    location: { landmarkId: 'alpha', displayName: 'Alpha Lounge' },
    dialogue: [
      { phase: 'announcement', text: 'Whispers are spilling from Alpha Lounge.' },
      { phase: 'live', text: 'Enter or interact at Alpha Lounge to verify the leak.' },
      { phase: 'completed', text: 'The leak went cold.' },
    ],
    weatherOverride: null,
    musicOverride: 'tense',
    citizenBehaviour: { mode: 'gather', citizenCount: 6 },
  },
  {
    id: 'arena-rumour',
    title: 'Arena Rumour',
    description: 'Training chatter at the Arena gate. Inspect the Arena to participate.',
    rarity: 'uncommon',
    duration: 40000,
    reward: { type: 'rep', amount: 10, label: '+10 REP for checking the rumour' },
    location: { landmarkId: 'arena', displayName: 'Future Arena' },
    dialogue: [
      { phase: 'announcement', text: 'Arena rumours are spreading.' },
      { phase: 'live', text: 'Inspect the Arena gate to take part.' },
      { phase: 'completed', text: 'The rumour died down.' },
    ],
    weatherOverride: null,
    musicOverride: 'upbeat',
    citizenBehaviour: { mode: 'gather', citizenCount: 8 },
  },
  {
    id: 'government-announcement',
    title: 'Government Announcement',
    description: 'A civic bulletin posts at Government Quarter. Interact to acknowledge it.',
    rarity: 'uncommon',
    duration: 45000,
    reward: { type: 'badge', label: 'Civic Acknowledgement' },
    location: { landmarkId: 'government', displayName: 'Government Quarter' },
    dialogue: [
      { phase: 'announcement', text: 'Government Quarter has a fresh bulletin.' },
      { phase: 'live', text: 'Press E at Government Quarter to acknowledge.' },
      { phase: 'completed', text: 'The bulletin cycle closed.' },
    ],
    weatherOverride: null,
    musicOverride: null,
    citizenBehaviour: { mode: 'gather', citizenCount: 9 },
  },
  {
    id: 'double-rep',
    title: 'Double REP',
    description: 'A city-wide boost — every quest and reward pays out double REP while this lasts.',
    rarity: 'epic',
    duration: 60000,
    reward: { type: 'multiplier', amount: 2, label: '2x REP from all quests, city-wide' },
    location: { landmarkId: null, displayName: 'City-wide' },
    dialogue: [
      { phase: 'announcement', text: 'Word is going around about a city-wide REP boost.' },
      { phase: 'live', text: 'Double REP is active across all of RugTown!' },
      { phase: 'completed', text: 'The REP boost has ended. Back to normal.' },
    ],
    weatherOverride: null,
    musicOverride: 'upbeat',
    citizenBehaviour: { mode: 'none' },
  },
];
