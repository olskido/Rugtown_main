/**
 * MinimapLandmarks.ts — landmark roster for map UI from canonical WorldObjects.
 */

import { getWorldObject, isInteractionLive, WORLD_OBJECTS, type WorldObject } from '../world/WorldObjects';
import { ENTERABLE_BUILDINGS } from '../world/EnterableBuildings';
import { getDistrictAtWorld } from '../world/WorldDistricts';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../world/WorldMapScale';

export interface MinimapLandmark {
  id: string;
  name: string;
  icon: string;
  worldX: number;
  worldY: number;
  fx: number;
  fy: number;
  districtName: string;
  locked: boolean;
  live: boolean;
  enterable: boolean;
}

export function buildMinimapLandmarks(
  worldW = WORLD_WIDTH,
  worldH = WORLD_HEIGHT,
): MinimapLandmark[] {
  return WORLD_OBJECTS.map((obj) => landmarkFromObject(obj, worldW, worldH));
}

function landmarkFromObject(obj: WorldObject, worldW: number, worldH: number): MinimapLandmark {
  const worldX = obj.x * worldW;
  const worldY = obj.y * worldH;
  const district = getDistrictAtWorld(worldX, worldY);
  return {
    id: obj.id,
    name: obj.displayName,
    icon: obj.futureIcon,
    worldX,
    worldY,
    fx: obj.x,
    fy: obj.y,
    districtName: district?.name ?? 'RugTown',
    locked: obj.interactionType === 'locked',
    live: isInteractionLive(obj),
    enterable: ENTERABLE_BUILDINGS.some((building) => building.worldObjectId === obj.id),
  };
}

export function getMinimapLandmark(id: string, worldW = WORLD_WIDTH, worldH = WORLD_HEIGHT): MinimapLandmark | undefined {
  const obj = getWorldObject(id);
  return obj ? landmarkFromObject(obj, worldW, worldH) : undefined;
}

export const MINIMAP_LANDMARK_COUNT = WORLD_OBJECTS.length;
