/**
 * Shared exterior interaction copy for buildings without dedicated panels.
 */
import { getBuildingEntry } from '../../game/world/BuildingRegistry';
import { getNpcByLandmark, pickNpcLine } from '../../game/npcs/FunctionalNpcs';

export function getGenericBuildingModal(id: string, playerRep: number, playerLevel: number): {
  title: string;
  sub: string;
  paragraphs: string[];
  actions?: Array<{ label: string; hint: string }>;
} {
  const entry = getBuildingEntry(id);
  const npc = getNpcByLandmark(id);
  const title = entry?.displayName ?? id;
  const sub = entry?.summary ?? 'RugTown landmark';
  const paragraphs: string[] = [];

  if (entry?.access === 'locked') {
    paragraphs.push(entry.lockedMessage ?? 'This building is locked.');
  } else if (entry?.access === 'coming_soon') {
    paragraphs.push(entry.lockedMessage ?? 'This location is coming soon — training and previews only.');
  } else {
    paragraphs.push(entry?.summary ?? 'You inspect the landmark carefully.');
  }

  if (npc) {
    paragraphs.push(`${npc.displayName}: “${pickNpcLine(npc, 'greet')}”`);
  }

  switch (id) {
    case 'government':
      paragraphs.push('Weekly quests reset Monday 00:00 UTC. Civic notices pin here first.');
      break;
    case 'trading_academy':
      paragraphs.push('Tip: missions pay XP from the server catalog — never trust a client-typed reward.');
      break;
    case 'financial_office':
      paragraphs.push(`Your ledger snapshot: Level ${playerLevel} · ${playerRep.toLocaleString()} REP.`);
      break;
    case 'holder_bank':
      paragraphs.push('Account vault preview only. Wallet and token features are not live in this phase.');
      break;
    case 'research_observatory':
      paragraphs.push('Track city-event heat from the Events panel. Idle watching grants nothing.');
      break;
    case 'market_shop':
      paragraphs.push('Browse mock stall goods tied to in-game items only. No purchases.');
      break;
    case 'tournament_hall':
      paragraphs.push('Challenge desk open for score records. No paid brackets yet.');
      break;
    case 'nft_gallery':
      paragraphs.push('Pixel exhibits on loan from city artists. Cosmetics only — no minting.');
      break;
    case 'nft_creator_studio':
      paragraphs.push('Workshop tips for appearances. Open Character to edit your look.');
      break;
    case 'park':
      paragraphs.push('Quiet green edge of town. Good meet-up spot for party gatherings.');
      break;
    case 'coffee':
      paragraphs.push('Enter through the door for the full interior. Milo keeps the gossip warm.');
      break;
    default:
      break;
  }

  return { title, sub, paragraphs };
}
