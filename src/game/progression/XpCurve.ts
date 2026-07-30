/**
 * XpCurve.ts — centralized Level 1–50 XP thresholds.
 * Curve v3 (gameplay completion): slower early levels so onboarding (~320 XP)
 * lands around level 2, not a multi-level spike. Existing players keep
 * grandfathered levels via migrate_progression_curve_v3 on the server.
 *
 * Targets: L1–5 accessible, L6–15 regular play, L16–30 sustained, 30+ long-term.
 */

import { MAX_LEVEL } from './types';

/** Client curve version — must stay aligned with SQL rt_xp_required_for_level_v3. */
export const PROGRESSION_CURVE_VERSION = 3;

/**
 * XP required to advance FROM `level` TO `level + 1`.
 * Level 1 → 2 costs xpRequiredForLevel(1).
 */
export function xpRequiredForLevel(level: number): number {
  if (level < 1) return xpRequiredForLevel(1);
  if (level >= MAX_LEVEL) return 0;
  // 200 at L1, 250 at L2, 310 at L3 — steeper than v2 without punishing mid-game.
  const step = level - 1;
  return Math.round(200 + (50 * step) + (5 * step * step));
}

/** Cumulative lifetime XP needed to *reach* `level` (level 1 = 0). */
export function totalXpRequiredForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  let total = 0;
  for (let L = 1; L < clamped; L++) {
    total += xpRequiredForLevel(L);
  }
  return total;
}

/** Derive level from lifetime XP (clamped 1..MAX_LEVEL). */
export function levelFromLifetimeXp(lifetimeXp: number): number {
  const xp = Math.max(0, Math.floor(lifetimeXp));
  let level = 1;
  let spent = 0;
  while (level < MAX_LEVEL) {
    const need = xpRequiredForLevel(level);
    if (spent + need > xp) break;
    spent += need;
    level++;
  }
  return level;
}

/** XP progress within the current level, 0–100. At max level returns 100. */
export function levelProgressPercent(lifetimeXp: number): {
  level: number;
  currentXp: number;
  xpToNext: number;
  percent: number;
} {
  const level = levelFromLifetimeXp(lifetimeXp);
  const floor = totalXpRequiredForLevel(level);
  const currentXp = Math.max(0, Math.floor(lifetimeXp) - floor);
  if (level >= MAX_LEVEL) {
    return { level, currentXp, xpToNext: 0, percent: 100 };
  }
  const xpToNext = xpRequiredForLevel(level);
  const percent = xpToNext <= 0 ? 100 : Math.min(100, Math.max(0, (currentXp / xpToNext) * 100));
  return { level, currentXp, xpToNext, percent };
}

/** Total XP needed to reach MAX_LEVEL from 0. */
export function totalXpToMaxLevel(): number {
  return totalXpRequiredForLevel(MAX_LEVEL);
}

/**
 * At max level, excess XP is kept in lifetimeXp for stats/season prep
 * but does not increase level. currentXp shows overflow past the final floor.
 */
export function applyXpGain(lifetimeXp: number, amount: number): {
  lifetimeXp: number;
  previousLevel: number;
  newLevel: number;
  levelsGained: number;
} {
  const add = Math.max(0, Math.floor(amount));
  const previousLevel = levelFromLifetimeXp(lifetimeXp);
  const nextLifetime = lifetimeXp + add;
  const newLevel = levelFromLifetimeXp(nextLifetime);
  return {
    lifetimeXp: nextLifetime,
    previousLevel,
    newLevel,
    levelsGained: Math.max(0, newLevel - previousLevel),
  };
}
