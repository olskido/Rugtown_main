/**
 * Client catalog for party shared missions (mirrors DB seeds).
 * Server remains authoritative for start / contribute / claim.
 */

export interface PartyMissionDef {
  id: string;
  title: string;
  description: string;
  minMembers: number;
  /** Allow solo practice completion in guest/dev when no second player */
  allowSoloFallback: boolean;
  objectiveType: string;
  target: number;
  objectiveRef?: string;
  xpReward: number;
  repReward: number;
  active: boolean;
}

export const PARTY_MISSION_CATALOG: PartyMissionDef[] = [
  {
    id: 'party_three_districts',
    title: 'District Sweep',
    description: 'As a crew, visit three distinct districts.',
    minMembers: 2,
    allowSoloFallback: true,
    objectiveType: 'visit_districts',
    target: 3,
    xpReward: 80,
    repReward: 12,
    active: true,
  },
  {
    id: 'party_city_event',
    title: 'Event Together',
    description: 'Complete one city event while party members are present.',
    minMembers: 2,
    allowSoloFallback: true,
    objectiveType: 'join_event',
    target: 1,
    xpReward: 70,
    repReward: 10,
    active: true,
  },
  {
    id: 'party_spring_meet',
    title: 'Meet at Spring Water',
    description: 'Gather the party at Spring Water.',
    minMembers: 2,
    allowSoloFallback: true,
    objectiveType: 'visit_landmark',
    target: 1,
    objectiveRef: 'fountain',
    xpReward: 50,
    repReward: 8,
    active: true,
  },
  {
    id: 'party_multi_delivery',
    title: 'City Delivery Run',
    description: 'Interact with Notice Board, Coffee Shop, and Market as a party.',
    minMembers: 2,
    allowSoloFallback: true,
    objectiveType: 'discover_landmarks',
    target: 3,
    xpReward: 90,
    repReward: 14,
    active: true,
  },
  {
    id: 'party_twin_landmarks',
    title: 'Twin Landmark Dash',
    description: 'Interact with Bridge and Whale Tower within the mission window.',
    minMembers: 2,
    allowSoloFallback: true,
    objectiveType: 'discover_landmarks',
    target: 2,
    xpReward: 75,
    repReward: 11,
    active: true,
  },
];
