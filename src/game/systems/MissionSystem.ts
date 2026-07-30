/**
 * MissionSystem — re-export from missions package (gameplay completion phase).
 * Existing imports of ../systems/MissionSystem keep working.
 */
export {
  MissionSystem,
  createStarterMissionSystem,
} from '../missions/MissionSystem';
export type {
  MissionDefinition,
  MissionProgress,
  MissionObjectiveType,
} from '../missions/MissionSystem';
