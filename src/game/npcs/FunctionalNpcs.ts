/**
 * Named functional NPCs for mission dialogue and objective roles.
 * Ambient crowd NPCs remain in WorldScene; these roles are mission-facing.
 */

export interface FunctionalNpcDef {
  roleId: string;
  displayName: string;
  homeLandmarkId: string;
  title: string;
  greetings: string[];
  missionLines: string[];
  repeatLines: string[];
  cooldownMs: number;
}

export const FUNCTIONAL_NPCS: FunctionalNpcDef[] = [
  {
    roleId: 'starter_guide',
    displayName: 'Town Crier',
    homeLandmarkId: 'fountain',
    title: 'Starter Guide',
    greetings: ['New face! RugTown eats the unprepared.', 'Listen close — rumours pay better than guesses.'],
    missionLines: ['Check your mission list. One step at a time.', 'Spring Water first. Always.'],
    repeatLines: ['Still here? Good. Finish what you started.'],
    cooldownMs: 8_000,
  },
  {
    roleId: 'notice_guide',
    displayName: 'Pin Clerk Nora',
    homeLandmarkId: 'notice',
    title: 'Notice Board Guide',
    greetings: ['Fresh pins every morning.', 'If it is on the board, it is fair game.'],
    missionLines: ['Accept a lead. Completing it is your problem.'],
    repeatLines: ['Board does not refresh for impatient degens.'],
    cooldownMs: 10_000,
  },
  {
    roleId: 'coffee_worker',
    displayName: 'Milo',
    homeLandmarkId: 'coffee',
    title: 'Coffee Shop Worker',
    greetings: ['Espresso or gossip?', 'Sit. Rumours brew hotter than the roast.'],
    missionLines: ['Heard the ledger never made it past market open.', 'Talk soft — walls have bagholders.'],
    repeatLines: ['Same blend, same chatter.'],
    cooldownMs: 10_000,
  },
  {
    roleId: 'market_trader',
    displayName: 'Pip',
    homeLandmarkId: 'market',
    title: 'Market Trader',
    greetings: ['Charts lie. Foot traffic does not.', 'You buying signal or selling hope?'],
    missionLines: ['City events spike volume. Watch the banners.', 'My ledger went missing. That is not a meme.'],
    repeatLines: ['Still no ledger. Still no peace.'],
    cooldownMs: 10_000,
  },
  {
    roleId: 'academy_mentor',
    displayName: 'Coach Vex',
    homeLandmarkId: 'trading_academy',
    title: 'Trading Academy Mentor',
    greetings: ['Lesson one: size down.', 'Patience is a position.'],
    missionLines: ['Read the board. Then walk the city. Then talk.'],
    repeatLines: ['Homework is not optional.'],
    cooldownMs: 12_000,
  },
  {
    roleId: 'alpha_informant',
    displayName: 'Whisper Kai',
    homeLandmarkId: 'alpha',
    title: 'Alpha Lounge Informant',
    greetings: ['Quiet voices last longer.', 'I do not give free alpha. I trade favours.'],
    missionLines: ['Whale Tower blinked. Confirm it yourself.', 'Bring proof, not vibes.'],
    repeatLines: ['Come back when you have a receipt.'],
    cooldownMs: 12_000,
  },
  {
    roleId: 'whale_analyst',
    displayName: 'Lens',
    homeLandmarkId: 'whale',
    title: 'Whale Tower Analyst',
    greetings: ['Big wallets do not wave.', 'Movement logged. Motive unknown.'],
    missionLines: ['Stay for the alert. Idle watchers get nothing.'],
    repeatLines: ['Still scanning.'],
    cooldownMs: 12_000,
  },
  {
    roleId: 'government_official',
    displayName: 'Clerk Rowan',
    homeLandmarkId: 'government',
    title: 'Government Official',
    greetings: ['Forms first. Glory later.', 'Weekly cycles reset at UTC midnight Monday.'],
    missionLines: ['Vault stays locked. That is policy, not a bug.', 'Bring civic reports here.'],
    repeatLines: ['Next.'],
    cooldownMs: 12_000,
  },
  {
    roleId: 'arena_coordinator',
    displayName: 'Ringmaster Sol',
    homeLandmarkId: 'arena',
    title: 'Arena Coordinator',
    greetings: ['No paid brackets yet. Training only.', 'Warm up at Tournament Hall.'],
    missionLines: ['Check the Arena gate, then the Hall desk.'],
    repeatLines: ['When the Arena opens, you will hear it.'],
    cooldownMs: 12_000,
  },
  {
    roleId: 'observatory_researcher',
    displayName: 'Astra',
    homeLandmarkId: 'research_observatory',
    title: 'Observatory Researcher',
    greetings: ['Signals in the noise.', 'Events leave traces if you look twice.'],
    missionLines: ['Track active city events from here.'],
    repeatLines: ['Sky is still loud.'],
    cooldownMs: 12_000,
  },
];

export function getNpcByRole(roleId: string): FunctionalNpcDef | undefined {
  return FUNCTIONAL_NPCS.find((n) => n.roleId === roleId);
}

export function getNpcByLandmark(landmarkId: string): FunctionalNpcDef | undefined {
  return FUNCTIONAL_NPCS.find((n) => n.homeLandmarkId === landmarkId);
}

export function pickNpcLine(npc: FunctionalNpcDef, mode: 'greet' | 'mission' | 'repeat'): string {
  const pool =
    mode === 'greet' ? npc.greetings : mode === 'mission' ? npc.missionLines : npc.repeatLines;
  return pool[Math.floor(Math.random() * pool.length)] ?? npc.greetings[0];
}
