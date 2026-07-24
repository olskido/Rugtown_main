/**
 * WorldMapScale.ts
 * ────────────────
 * Phase 10A — canonical source→world scale for main_rugtown.png.
 *
 * Actual asset on disk is 2172×724 (aspect 3:1). The brief cited
 * 2048×682 as a design target; we bind to the real file dimensions so
 * the background never stretches.
 *
 * WORLD_SCALE = 2 → 4344 × 1448 world pixels.
 * Rationale: player visual footprint ≈ 44×68 (CHAR×2); at 2× source
 * pixels, default zoom (0.85) keeps the plaza readable on mobile and
 * desktop without the previous 130% close-up crop.
 */

export const WORLD_IMAGE_WIDTH = 2172;
export const WORLD_IMAGE_HEIGHT = 724;

/** Integer multiplier: worldPx = imagePx * WORLD_SCALE (uniform). */
export const WORLD_SCALE = 2;

export const WORLD_WIDTH = WORLD_IMAGE_WIDTH * WORLD_SCALE;   // 4344
export const WORLD_HEIGHT = WORLD_IMAGE_HEIGHT * WORLD_SCALE; // 1448

export const WORLD_OFFSET_X = 0;
export const WORLD_OFFSET_Y = 0;

export const WORLD_SCALE_X = WORLD_WIDTH / WORLD_IMAGE_WIDTH;
export const WORLD_SCALE_Y = WORLD_HEIGHT / WORLD_IMAGE_HEIGHT;

if (WORLD_SCALE_X !== WORLD_SCALE_Y) {
  throw new Error(
    `[WorldMapScale] Non-uniform scale ${WORLD_SCALE_X} vs ${WORLD_SCALE_Y}`,
  );
}

export function imageToWorldX(x: number): number {
  return WORLD_OFFSET_X + x * WORLD_SCALE_X;
}

export function imageToWorldY(y: number): number {
  return WORLD_OFFSET_Y + y * WORLD_SCALE_Y;
}

export function imageToWorldW(w: number): number {
  return w * WORLD_SCALE_X;
}

export function imageToWorldH(h: number): number {
  return h * WORLD_SCALE_Y;
}

export function worldToImageX(x: number): number {
  return (x - WORLD_OFFSET_X) / WORLD_SCALE_X;
}

export function worldToImageY(y: number): number {
  return (y - WORLD_OFFSET_Y) / WORLD_SCALE_Y;
}

export const CAMERA_ZOOM_DEFAULT = 0.85;
export const CAMERA_ZOOM_MIN = 0.85;
export const CAMERA_ZOOM_MAX = 1.70;
export const CAMERA_FOLLOW_LERP = 0.22;

/**
 * Building/world solids are OFF for now.
 * Geometry remains in WorldCollisionGeometry for later re-enable.
 * Set true to block buildings, river, and fountain basin again.
 */
export const WORLD_COLLISION_ENABLED = false;

/** Phase 10B player walk speed (was 252; −30% → 176.4, integer 176). */
export const PLAYER_SPEED = 176;
