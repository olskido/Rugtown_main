/**
 * WorldMapCanvas.tsx — Phase 10C canvas renderer for compact + expanded maps.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Direction } from '../../game/characters/animation/CharacterDirection';
import { buildMinimapLandmarks, type MinimapLandmark } from '../../game/minimap/MinimapLandmarks';
import {
  COMPACT_LANDMARK_IDS,
  MINIMAP_TEXTURE_FALLBACK_URL,
  MINIMAP_TEXTURE_URL,
  MINIMAP_THEME,
} from '../../game/minimap/MinimapTheme';
import {
  cameraViewportToMapRect,
  computeMapFit,
  isInsideMapFit,
  mapToWorld,
  mapToWorldExpanded,
  type MapFitRect,
  worldToExpandedMap,
  worldToMap,
} from '../../game/minimap/MinimapTransform';
import type {
  MinimapEventMarker,
  MinimapFilters,
  MinimapLiveSnapshot,
  MinimapNpcMarker,
  MinimapRemoteMarker,
  MinimapWaypoint,
} from '../../game/minimap/MinimapTypes';
import { WORLD_DISTRICTS } from '../../game/world/WorldDistricts';
import { WATER_ZONES } from '../../game/world/NewCanonicalWorld';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../game/world/WorldMapScale';

export interface WorldMapDrawOptions {
  mode: 'compact' | 'expanded';
  live: MinimapLiveSnapshot;
  remotes: MinimapRemoteMarker[];
  landmarks: MinimapLandmark[];
  missionLandmarkId: string | null;
  filters: MinimapFilters;
  selectedLandmarkId: string | null;
  waypoint: MinimapWaypoint | null;
  /** Expanded-only pan/zoom inside the map panel. */
  expandedPanX?: number;
  expandedPanY?: number;
  expandedZoom?: number;
  showLandmarkLabels?: boolean;
  showDistrictNames?: boolean;
  pulsePhase?: number;
  onDebugFrame?: (info: {
    fit: MapFitRect;
    playerMapX: number;
    playerMapY: number;
    viewport: ReturnType<typeof cameraViewportToMapRect>;
  }) => void;
}

const FACING_ANGLE: Record<Direction, number> = {
  right: 0,
  down: Math.PI / 2,
  left: Math.PI,
  up: -Math.PI / 2,
};

let sharedTexture: HTMLImageElement | null = null;
let textureLoading: Promise<HTMLImageElement> | null = null;

function loadMapTexture(): Promise<HTMLImageElement> {
  if (sharedTexture?.complete) return Promise.resolve(sharedTexture);
  if (textureLoading) return textureLoading;
  textureLoading = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      sharedTexture = img;
      resolve(img);
    };
    img.onerror = () => {
      const fallback = new Image();
      fallback.onload = () => {
        sharedTexture = fallback;
        resolve(fallback);
      };
      fallback.src = MINIMAP_TEXTURE_FALLBACK_URL;
    };
    img.src = MINIMAP_TEXTURE_URL;
  });
  return textureLoading;
}

function mapPoint(
  wx: number,
  wy: number,
  fit: MapFitRect,
  mode: 'compact' | 'expanded',
  panX: number,
  panY: number,
  zoom: number,
) {
  if (mode === 'expanded') return worldToExpandedMap(wx, wy, fit, panX, panY, zoom);
  return worldToMap(wx, wy, fit);
}

export function drawWorldMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  texture: HTMLImageElement | null,
  opts: WorldMapDrawOptions,
): MapFitRect {
  const {
    mode,
    live,
    remotes,
    landmarks,
    missionLandmarkId,
    filters,
    selectedLandmarkId,
    waypoint,
    expandedPanX = 0,
    expandedPanY = 0,
    expandedZoom = 1,
    showLandmarkLabels = false,
    showDistrictNames = false,
    pulsePhase = 0,
    onDebugFrame,
  } = opts;

  const padding = mode === 'compact' ? 2 : 8;
  const fit = computeMapFit(w, h, padding);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#060e12';
  ctx.fillRect(0, 0, w, h);

  // Base texture
  if (texture?.complete) {
    ctx.drawImage(texture, fit.offsetX, fit.offsetY, fit.width, fit.height);
  } else {
    ctx.fillStyle = '#0a1418';
    ctx.fillRect(fit.offsetX, fit.offsetY, fit.width, fit.height);
  }

  // Dark readability overlay
  ctx.fillStyle = MINIMAP_THEME.overlay;
  ctx.fillRect(fit.offsetX, fit.offsetY, fit.width, fit.height);

  // Water zones (simplified)
  for (const z of WATER_ZONES) {
    const tl = mapPoint(z.x, z.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
    const br = mapPoint(z.x + z.width, z.y + z.height, fit, mode, expandedPanX, expandedPanY, expandedZoom);
    ctx.fillStyle = MINIMAP_THEME.water.fill;
    ctx.strokeStyle = MINIMAP_THEME.water.stroke;
    ctx.lineWidth = 1;
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }

  // Districts
  if (filters.districtNames || mode === 'expanded') {
    for (const d of WORLD_DISTRICTS) {
      const tl = mapPoint(d.worldX, d.worldY, fit, mode, expandedPanX, expandedPanY, expandedZoom);
      const br = mapPoint(
        d.worldX + d.worldW,
        d.worldY + d.worldH,
        fit,
        mode,
        expandedPanX,
        expandedPanY,
        expandedZoom,
      );
      ctx.fillStyle = MINIMAP_THEME.district.fill;
      ctx.strokeStyle = MINIMAP_THEME.district.stroke;
      ctx.lineWidth = 1;
      ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

      if (showDistrictNames && mode === 'expanded') {
        const cx = (tl.x + br.x) / 2;
        const cy = tl.y + 12;
        ctx.font = '10px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = MINIMAP_THEME.district.label;
        ctx.fillText(d.name, cx, cy);
      }
    }
  } else {
    // Compact: subtle vertical separators only
    for (let i = 1; i < WORLD_DISTRICTS.length; i++) {
      const d = WORLD_DISTRICTS[i];
      const p = mapPoint(d.worldX, 0, fit, mode, expandedPanX, expandedPanY, expandedZoom);
      ctx.strokeStyle = MINIMAP_THEME.district.stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, fit.offsetY);
      ctx.lineTo(p.x, fit.offsetY + fit.height);
      ctx.stroke();
    }
  }

  // Camera viewport (gameplay camera — not expanded map pan)
  const vp = cameraViewportToMapRect(live.camera, fit);
  if (mode === 'expanded') {
    const tl = worldToExpandedMap(live.camera.scrollX, live.camera.scrollY, fit, expandedPanX, expandedPanY, expandedZoom);
    const br = worldToExpandedMap(
      live.camera.scrollX + live.camera.viewW,
      live.camera.scrollY + live.camera.viewH,
      fit,
      expandedPanX,
      expandedPanY,
      expandedZoom,
    );
    ctx.strokeStyle = MINIMAP_THEME.viewport.stroke;
    ctx.fillStyle = MINIMAP_THEME.viewport.fill;
    ctx.lineWidth = MINIMAP_THEME.viewport.lineWidth;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  } else {
    ctx.strokeStyle = MINIMAP_THEME.viewport.stroke;
    ctx.fillStyle = MINIMAP_THEME.viewport.fill;
    ctx.lineWidth = MINIMAP_THEME.viewport.lineWidth;
    ctx.strokeRect(vp.x, vp.y, vp.w, vp.h);
    ctx.fillRect(vp.x, vp.y, vp.w, vp.h);
  }

  // Waypoint + mission route hint
  if (waypoint) {
    const wp = mapPoint(waypoint.x, waypoint.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
    const pl = mapPoint(live.player.x, live.player.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
    ctx.strokeStyle = MINIMAP_THEME.waypoint.stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pl.x, pl.y);
    ctx.lineTo(wp.x, wp.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawDiamond(ctx, wp.x, wp.y, MINIMAP_THEME.waypoint.radius, MINIMAP_THEME.waypoint.fill, MINIMAP_THEME.waypoint.stroke);
  }

  // Landmarks
  if (filters.landmarks) {
    for (const lm of landmarks) {
      const compactSkip = mode === 'compact' && !COMPACT_LANDMARK_IDS.has(lm.id);
      if (compactSkip) continue;
      const p = mapPoint(lm.worldX, lm.worldY, fit, mode, expandedPanX, expandedPanY, expandedZoom);
      const isMission = filters.missions && missionLandmarkId === lm.id;
      const isSelected = selectedLandmarkId === lm.id;
      const r = isMission ? MINIMAP_THEME.mission.radius : (mode === 'expanded' ? MINIMAP_THEME.landmark.majorRadius : MINIMAP_THEME.landmark.radius);
      const fill = lm.locked ? MINIMAP_THEME.landmark.lockedFill : MINIMAP_THEME.landmark.fill;
      const stroke = lm.locked ? MINIMAP_THEME.landmark.lockedStroke : MINIMAP_THEME.landmark.stroke;

      if (isMission) {
        const pulse = 1 + Math.sin(pulsePhase * 2) * 0.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * pulse, 0, Math.PI * 2);
        ctx.fillStyle = MINIMAP_THEME.mission.glow;
        ctx.fill();
      }

      if (mode === 'expanded' && showLandmarkLabels) {
        ctx.font = '9px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = MINIMAP_THEME.label.shadow;
        ctx.fillText(`${lm.icon} ${lm.name}`, p.x + 1, p.y - 9);
        ctx.fillStyle = isSelected ? '#fff6d0' : MINIMAP_THEME.label.text;
        ctx.fillText(`${lm.icon} ${lm.name}`, p.x, p.y - 10);
      } else if (mode === 'compact') {
        ctx.font = '8px serif';
        ctx.textAlign = 'center';
        ctx.fillText(lm.icon, p.x, p.y + 3);
      }

      if (mode === 'expanded' && lm.enterable) {
        ctx.strokeStyle = '#5ce1e6';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - r - 3, p.y - r - 3, (r + 3) * 2, (r + 3) * 2);
      }

      drawCircle(ctx, p.x, p.y, r, fill, stroke, isSelected ? 2 : 1);
      if (lm.locked && mode === 'expanded') {
        ctx.font = '7px serif';
        ctx.fillStyle = '#ccc';
        ctx.fillText('🔒', p.x, p.y + 12);
      }
    }
  }

  // Events
  if (filters.events) {
    for (const ev of live.events) {
      const p = mapPoint(ev.x, ev.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
      const pulse = 1 + Math.sin(pulsePhase * 2.2) * 0.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, MINIMAP_THEME.event.radius * pulse, 0, Math.PI * 2);
      ctx.fillStyle = MINIMAP_THEME.event.glow;
      ctx.fill();
      drawCircle(ctx, p.x, p.y, MINIMAP_THEME.event.radius, MINIMAP_THEME.event.fill, MINIMAP_THEME.event.stroke);
    }
  }

  // NPCs
  if (filters.npcs) {
    const maxNpcs = mode === 'compact' ? 40 : 200;
    const npcs = live.npcs.slice(0, maxNpcs);
    for (const n of npcs) {
      const p = mapPoint(n.x, n.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
      const fill = n.roaming ? MINIMAP_THEME.npc.roamingFill : MINIMAP_THEME.npc.fill;
      drawCircle(ctx, p.x, p.y, MINIMAP_THEME.npc.radius, fill, MINIMAP_THEME.npc.stroke);
    }
  }

  // Remote players
  if (filters.realPlayers) {
    for (const r of remotes) {
      const p = mapPoint(r.x, r.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
      ctx.beginPath();
      ctx.arc(p.x, p.y, MINIMAP_THEME.remotePlayer.radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = MINIMAP_THEME.remotePlayer.glow;
      ctx.fill();
      drawCircle(
        ctx,
        p.x,
        p.y,
        MINIMAP_THEME.remotePlayer.radius,
        MINIMAP_THEME.remotePlayer.fill,
        MINIMAP_THEME.remotePlayer.stroke,
      );
    }
  }

  // Local player (always on top)
  const pl = mapPoint(live.player.x, live.player.y, fit, mode, expandedPanX, expandedPanY, expandedZoom);
  const pulse = 1 + Math.sin(pulsePhase * 3) * 0.12;
  ctx.beginPath();
  ctx.arc(pl.x, pl.y, (MINIMAP_THEME.localPlayer.radius + 3) * pulse, 0, Math.PI * 2);
  ctx.fillStyle = MINIMAP_THEME.localPlayer.glow;
  ctx.fill();
  drawLocalPlayer(ctx, pl.x, pl.y, live.player.facing);

  onDebugFrame?.({
    fit,
    playerMapX: pl.x,
    playerMapY: pl.y,
    viewport: vp,
  });

  return fit;
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  stroke: string,
  lineW = 1,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineW;
  ctx.stroke();
}

function drawDiamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  stroke: string,
) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawLocalPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, facing: Direction) {
  const t = MINIMAP_THEME.localPlayer;
  drawCircle(ctx, x, y, t.radius, t.fill, t.stroke, 2);
  const ang = FACING_ANGLE[facing];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(t.arrowLen, 0);
  ctx.lineTo(-2, -3);
  ctx.lineTo(-2, 3);
  ctx.closePath();
  ctx.fillStyle = t.stroke;
  ctx.fill();
  ctx.restore();
}

export interface WorldMapCanvasProps extends Omit<WorldMapDrawOptions, 'pulsePhase'> {
  className?: string;
  ariaLabel?: string;
  onClick?: (mx: number, my: number, fit: MapFitRect) => void;
  onHover?: (mx: number, my: number, fit: MapFitRect) => void;
  interactive?: boolean;
}

export function WorldMapCanvas({
  className,
  ariaLabel,
  onClick,
  onHover,
  interactive = false,
  ...drawOpts
}: WorldMapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fitRef = useRef<MapFitRect | null>(null);
  const pulseRef = useRef(0);
  const rafRef = useRef(0);
  const optsRef = useRef(drawOpts);
  optsRef.current = drawOpts;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pulseRef.current += 0.04;
    fitRef.current = drawWorldMap(ctx, w, h, sharedTexture, {
      ...optsRef.current,
      pulsePhase: pulseRef.current,
    });
  }, []);

  useEffect(() => {
    let alive = true;
    loadMapTexture().then(() => {
      if (alive) paint();
    });
    return () => { alive = false; };
  }, [paint]);

  useEffect(() => {
    const tick = () => {
      paint();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [paint]);

  const clientToMap = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  };

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label={ariaLabel}
      style={{ display: 'block', width: '100%', height: '100%', touchAction: interactive ? 'none' : 'auto' }}
      onClick={(e) => {
        if (!onClick) return;
        const p = clientToMap(e);
        if (!p || !fitRef.current) return;
        onClick(p.mx, p.my, fitRef.current);
      }}
      onMouseMove={(e) => {
        if (!onHover) return;
        const p = clientToMap(e);
        if (!p || !fitRef.current) return;
        onHover(p.mx, p.my, fitRef.current);
      }}
    />
  );
}

export function hitTestLandmark(
  mx: number,
  my: number,
  fit: MapFitRect,
  landmarks: MinimapLandmark[],
  mode: 'compact' | 'expanded',
  panX: number,
  panY: number,
  zoom: number,
  hitRadius = 10,
): MinimapLandmark | null {
  let best: MinimapLandmark | null = null;
  let bestD = hitRadius;
  for (const lm of landmarks) {
    const p = mapPoint(lm.worldX, lm.worldY, fit, mode, panX, panY, zoom);
    const d = Math.hypot(p.x - mx, p.y - my);
    if (d < bestD) {
      bestD = d;
      best = lm;
    }
  }
  return best;
}

/** Hit-test a remote-player marker on the expanded map (inspect, not proximity). */
export function hitTestRemote(
  mx: number,
  my: number,
  fit: MapFitRect,
  remotes: MinimapRemoteMarker[],
  mode: 'compact' | 'expanded',
  panX: number,
  panY: number,
  zoom: number,
  hitRadius = 14,
): MinimapRemoteMarker | null {
  let best: MinimapRemoteMarker | null = null;
  let bestD = hitRadius;
  for (const r of remotes) {
    const p = mapPoint(r.x, r.y, fit, mode, panX, panY, zoom);
    const d = Math.hypot(p.x - mx, p.y - my);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

export function resolveMapClickWorld(
  mx: number,
  my: number,
  fit: MapFitRect,
  mode: 'compact' | 'expanded',
  panX: number,
  panY: number,
  zoom: number,
) {
  if (!isInsideMapFit(mx, my, fit)) return null;
  if (mode === 'expanded') return mapToWorldExpanded(mx, my, fit, panX, panY, zoom);
  return mapToWorld(mx, my, fit);
}

export const DEFAULT_LANDMARKS = buildMinimapLandmarks(WORLD_WIDTH, WORLD_HEIGHT);
