/**
 * NameplateLayout.ts
 * ──────────────────
 * Screen-space collision avoidance for world name labels.
 * Does not move sprites — only nudges Phaser Text objects vertically
 * and fades/hides lower-priority labels when crowded.
 */

import Phaser from 'phaser';

export type NameplatePriority = 'local' | 'remote' | 'npc' | 'other';

const PRIORITY_RANK: Record<NameplatePriority, number> = {
  local: 0,
  remote: 1,
  npc: 2,
  other: 3,
};

export interface NameplateSlot {
  id: string;
  priority: NameplatePriority;
  /** Desired world-space anchor (typically above the head). */
  worldX: number;
  worldY: number;
  text: Phaser.GameObjects.Text;
  /** When true, this label must stay visible (local player). */
  forceVisible?: boolean;
}

export interface NameplateLayoutOptions {
  /** Minimum vertical gap between label centers in screen pixels. */
  minGapPx?: number;
  /** Max lower-priority labels kept when crowded (local always kept). */
  maxSecondary?: number;
}

function worldToScreen(
  cam: Phaser.Cameras.Scene2D.Camera,
  wx: number,
  wy: number,
): { x: number; y: number } {
  const wv = cam.worldView;
  const w = Math.max(1, wv.width);
  const h = Math.max(1, wv.height);
  return {
    x: ((wx - wv.x) / w) * cam.width,
    y: ((wy - wv.y) / h) * cam.height,
  };
}

/**
 * Shorten a display name for the nameplate (does not mutate source data).
 */
export function ellipsizeName(name: string, maxChars = 14): string {
  const t = name.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Resolve overlapping nameplates for the current camera frame.
 * Call once per update after provisional positions are set.
 */
export function layoutNameplates(
  cam: Phaser.Cameras.Scene2D.Camera,
  slots: NameplateSlot[],
  opts: NameplateLayoutOptions = {},
): void {
  const minGap = opts.minGapPx ?? 15;
  const maxSecondary = opts.maxSecondary ?? (cam.width < 500 ? 6 : 12);

  type Work = NameplateSlot & { sx: number; sy: number; h: number };
  const work: Work[] = [];

  for (const slot of slots) {
    if (!slot.text.active) continue;
    const sp = worldToScreen(cam, slot.worldX, slot.worldY);
    const h = Math.max(12, slot.text.displayHeight || 14);
    work.push({ ...slot, sx: sp.x, sy: sp.y, h });
  }

  for (const w of work) {
    const off =
      w.sx < -40
      || w.sx > cam.width + 40
      || w.sy < -40
      || w.sy > cam.height + 40;
    if (off && !w.forceVisible) {
      w.text.setVisible(false);
      w.text.setAlpha(1);
    }
  }

  const onScreen = work.filter((w) => w.text.visible || w.forceVisible);
  onScreen.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    return a.sy - b.sy;
  });

  let secondary = 0;
  for (const w of onScreen) {
    if (w.priority === 'local' || w.forceVisible) {
      w.text.setVisible(true);
      continue;
    }
    secondary += 1;
    if (secondary > maxSecondary) {
      w.text.setVisible(false);
    } else {
      w.text.setVisible(true);
    }
  }

  const visible = onScreen.filter((w) => w.text.visible);
  const placed: { sx: number; sy: number; h: number }[] = [];

  for (const w of visible) {
    let sy = w.sy;
    let guard = 0;
    while (guard < 8) {
      guard += 1;
      let hit = false;
      for (const p of placed) {
        if (Math.abs(p.sx - w.sx) > 56) continue;
        const gap = Math.abs(p.sy - sy);
        const need = (p.h + w.h) * 0.5 + minGap * 0.35;
        if (gap < need) {
          sy = Math.min(sy, p.sy) - need;
          hit = true;
        }
      }
      if (!hit) break;
    }

    sy = Phaser.Math.Clamp(sy, 10 + w.h * 0.5, cam.height - 8);
    placed.push({ sx: w.sx, sy, h: w.h });

    const world = cam.getWorldPoint(w.sx, sy);
    w.text.setPosition(Math.round(world.x), Math.round(world.y));

    if (w.priority === 'npc' && guard > 2) {
      w.text.setAlpha(0.55);
    } else {
      w.text.setAlpha(1);
    }
  }
}
