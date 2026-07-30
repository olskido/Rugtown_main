/**
 * BuildingSystem.ts — Phase 10D world-space landmark tags.
 *
 * FAR / VISIBLE / NEAR distance states, zoom-compensated scale,
 * clutter capping, mission/event accents. Created once and reused.
 */

import Phaser from 'phaser';
import {
  buildLandmarkCatalog,
  MAX_FULL_LABELS,
  type LabelVisibility,
  type LandmarkMeta,
  type LandmarkStatus,
} from '../interaction/LandmarkCatalog';
import { isLiveInteractionId } from '../world/WorldObjects';

interface LabelEntry {
  meta: LandmarkMeta;
  root: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Graphics;
  text: Phaser.GameObjects.Text;
  stem: Phaser.GameObjects.Graphics;
  visibility: LabelVisibility;
  alpha: number;
}

/** Crisp UI nameplate font — Cinzel blurs at small world sizes on mobile. */
const NAMEPLATE_FONT = 'Segoe UI, Helvetica Neue, Arial, sans-serif';

const COLORS = {
  bg: 0x060a0e,
  border: 0xc8902a,
  borderLocked: 0x6a7a88,
  borderMission: 0xe8b84b,
  borderEvent: 0xff6b3d,
  text: '#f5ecd6',
  textMuted: '#9aa3ad',
  textMission: '#ffe88a',
};

export interface LandmarkLabelDebug {
  id: string;
  visibility: LabelVisibility;
  dist: number;
  status: LandmarkStatus;
  labelX: number;
  labelY: number;
  entranceX: number;
  entranceY: number;
  visibilityRadius: number;
  interactionRadius: number;
}

export class BuildingSystem {
  private scene: Phaser.Scene;
  private entries: LabelEntry[] = [];
  private catalog: LandmarkMeta[] = [];
  private missionZoneId: string | null = null;
  private eventLandmarkIds = new Set<string>();
  private selectedTargetId: string | null = null;
  private lastDebug: LandmarkLabelDebug[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  init(worldW: number, worldH: number): void {
    this.destroyLabels();
    this.catalog = buildLandmarkCatalog(worldW, worldH);

    for (const meta of this.catalog) {
      const stem = this.scene.add.graphics().setDepth(4.4);
      const bg = this.scene.add.graphics().setDepth(4.5);
      const text = this.scene.add.text(0, 0, '', {
        fontFamily: NAMEPLATE_FONT,
        fontSize: '13px',
        fontStyle: 'bold',
        color: COLORS.text,
        stroke: '#000000',
        strokeThickness: 4,
        resolution: Math.min(3, Math.max(2, Math.round((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1))),
        align: 'center',
      }).setOrigin(0.5, 1).setDepth(4.6);

      const root = this.scene.add.container(meta.labelX, meta.labelY, [stem, bg, text])
        .setDepth(4.5)
        .setAlpha(0)
        .setVisible(false);

      this.entries.push({
        meta,
        root,
        bg,
        text,
        stem,
        visibility: 'far',
        alpha: 0,
      });
    }
  }

  getCatalog(): LandmarkMeta[] {
    return this.catalog;
  }

  getLastDebug(): LandmarkLabelDebug[] {
    return this.lastDebug;
  }

  setMissionZone(zoneId: string | null): void {
    this.missionZoneId = zoneId;
  }

  setEventLandmarkIds(ids: string[]): void {
    this.eventLandmarkIds = new Set(ids);
  }

  setSelectedTargetId(id: string | null): void {
    this.selectedTargetId = id;
  }

  updateLabels(
    zoom: number,
    animTick: number,
    playerX?: number,
    playerY?: number,
    _worldW?: number,
    _worldH?: number,
  ): void {
    if (this.entries.length === 0 || playerX === undefined || playerY === undefined) return;

    const pulseT = (Math.sin(animTick / 380) + 1) / 2;
    // Zoom compensation: keep labels readable at 0.85–1.70
    const invZoom = Phaser.Math.Clamp(1 / Math.max(0.85, zoom), 0.72, 1.15);

    type Ranked = { entry: LabelEntry; dist: number; vis: LabelVisibility; status: LandmarkStatus };
    const ranked: Ranked[] = [];

    for (const entry of this.entries) {
      const { meta } = entry;
      const dist = Math.hypot(playerX - meta.entranceX, playerY - meta.entranceY);
      let vis: LabelVisibility = 'far';
      if (dist <= meta.interactionRadius) vis = 'near';
      else if (dist <= meta.visibilityRadius) vis = 'visible';
      // Interactive buildings always keep a readable name within an extended radius.
      if (isLiveInteractionId(meta.id) && vis === 'far' && dist <= meta.visibilityRadius * 2.2) {
        vis = 'visible';
      }

      const status = this.resolveStatus(meta);
      ranked.push({ entry, dist, vis, status });
    }

    // Clutter: only closest MAX_FULL_LABELS get full nameplates; others far→icon-only or hidden
    // Live interactives are always included in the full-name set.
    ranked.sort((a, b) => a.dist - b.dist);
    const fullIds = new Set(
      ranked
        .filter((r) => r.vis !== 'far')
        .slice(0, MAX_FULL_LABELS)
        .map((r) => r.entry.meta.id),
    );
    for (const r of ranked) {
      if (isLiveInteractionId(r.entry.meta.id) && r.vis !== 'far') {
        fullIds.add(r.entry.meta.id);
      }
    }

    // Soft screen-space separation for near-overlapping labels
    const placed: { x: number; y: number }[] = [];

    this.lastDebug = [];

    for (const r of ranked) {
      const { entry, dist, status } = r;
      let vis = r.vis;
      if (vis !== 'far' && !fullIds.has(entry.meta.id)) {
        vis = dist <= entry.meta.interactionRadius * 1.15 ? 'near' : 'far';
      }

      entry.visibility = vis;
      const targetAlpha =
        vis === 'far' ? 0 :
        vis === 'visible' ? 0.78 :
        0.96;

      entry.alpha = Phaser.Math.Linear(entry.alpha, targetAlpha, 0.18);

      if (entry.alpha < 0.04) {
        entry.root.setVisible(false).setAlpha(0);
        this.lastDebug.push({
          id: entry.meta.id,
          visibility: 'far',
          dist,
          status,
          labelX: entry.meta.labelX,
          labelY: entry.meta.labelY,
          entranceX: entry.meta.entranceX,
          entranceY: entry.meta.entranceY,
          visibilityRadius: entry.meta.visibilityRadius,
          interactionRadius: entry.meta.interactionRadius,
        });
        continue;
      }

      entry.root.setVisible(true).setAlpha(entry.alpha);

      let lx = entry.meta.labelX;
      let ly = entry.meta.labelY;
      // Push apart if too close in world space
      for (const p of placed) {
        const ddx = lx - p.x;
        const ddy = ly - p.y;
        if (Math.hypot(ddx, ddy) < 36) {
          ly = p.y - 28;
        }
      }
      placed.push({ x: lx, y: ly });
      entry.root.setPosition(lx, ly);
      entry.root.setScale(invZoom);

      const isSelected = this.selectedTargetId === entry.meta.id;
      const isMission = status === 'mission';
      this.redrawLabel(entry, vis, status, isSelected, isMission ? pulseT : 0);

      this.lastDebug.push({
        id: entry.meta.id,
        visibility: vis,
        dist,
        status,
        labelX: lx,
        labelY: ly,
        entranceX: entry.meta.entranceX,
        entranceY: entry.meta.entranceY,
        visibilityRadius: entry.meta.visibilityRadius,
        interactionRadius: entry.meta.interactionRadius,
      });
    }
  }

  private resolveStatus(meta: LandmarkMeta): LandmarkStatus {
    if (this.missionZoneId === meta.id) return 'mission';
    if (this.eventLandmarkIds.has(meta.id)) return 'event';
    return meta.status;
  }

  private redrawLabel(
    entry: LabelEntry,
    vis: LabelVisibility,
    status: LandmarkStatus,
    selected: boolean,
    pulseT: number,
  ): void {
    const { meta, bg, text, stem } = entry;
    bg.clear();
    stem.clear();

    const locked = status === 'locked' || status === 'coming_soon';
    let border = COLORS.border;
    if (locked) border = COLORS.borderLocked;
    if (status === 'mission') border = COLORS.borderMission;
    if (status === 'event') border = COLORS.borderEvent;
    if (selected) border = 0xffe88a;

    let labelStr: string;
    if (vis === 'far') {
      labelStr = meta.icon;
    } else if (vis === 'visible') {
      labelStr = `${meta.icon} ${meta.shortName}`;
    } else {
      const stateIcon =
        status === 'locked' ? '🔒 ' :
        status === 'coming_soon' ? '⏳ ' :
        status === 'mission' ? '✦ ' :
        status === 'event' ? '⚡ ' : '';
      const actionBit =
        selected && meta.action !== 'none' && meta.action !== 'locked' && meta.action !== 'coming_soon'
          ? ` · ${meta.actionLabel.split(' ')[0]}`
          : locked
            ? (status === 'coming_soon' ? ' · Soon' : ' · Locked')
            : '';
      labelStr = `${stateIcon}${meta.icon} ${meta.shortName}${actionBit}`;
    }

    text.setText(labelStr);
    text.setColor(locked ? COLORS.textMuted : (status === 'mission' ? COLORS.textMission : COLORS.text));

    const padX = 8;
    const padY = 4;
    const tw = text.width + padX * 2;
    const th = text.height + padY * 2;
    const x0 = -tw / 2;
    const y0 = -th - 6;

    // Stem toward entrance
    stem.lineStyle(1.5, border, 0.55);
    stem.beginPath();
    stem.moveTo(0, -6);
    stem.lineTo(0, meta.labelOffsetY - 8);
    stem.strokePath();
    stem.fillStyle(border, 0.7);
    stem.fillCircle(0, meta.labelOffsetY - 6, 2);

    const alphaBg = 0.88 + (selected ? 0.06 : 0);
    bg.fillStyle(COLORS.bg, alphaBg);
    bg.lineStyle(selected ? 2 : 1.25, border, status === 'mission' ? 0.75 + 0.25 * pulseT : 0.85);
    bg.fillRoundedRect(x0, y0, tw, th, 4);
    bg.strokeRoundedRect(x0, y0, tw, th, 4);

    text.setPosition(0, -6);
  }

  destroy(): void {
    this.destroyLabels();
  }

  private destroyLabels(): void {
    for (const e of this.entries) {
      e.root.destroy(true);
    }
    this.entries = [];
  }
}
