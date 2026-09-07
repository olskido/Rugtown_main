/**
 * ExpandedWorldMap.tsx — Phase 10C full-world map modal with pan/zoom/filters.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_LANDMARKS,
  hitTestLandmark,
  hitTestRemote,
  resolveMapClickWorld,
  WorldMapCanvas,
} from './WorldMapCanvas';
import type { MinimapLandmark } from '../../game/minimap/MinimapLandmarks';
import type {
  MinimapFilters,
  MinimapLiveSnapshot,
  MinimapRemoteMarker,
  MinimapUiDebug,
} from '../../game/minimap/MinimapTypes';
import { loadMapFilters, saveMapFilters } from './useMinimapLiveData';
import type { MapFitRect } from '../../game/minimap/MinimapTransform';
import { isInsideMapFit } from '../../game/minimap/MinimapTransform';

export interface ExpandedWorldMapProps {
  open: boolean;
  onClose: () => void;
  live: MinimapLiveSnapshot;
  remotes: MinimapRemoteMarker[];
  missionLandmarkId: string | null;
  onCenterPlayer?: () => void;
  onDebugUpdate?: (debug: MinimapUiDebug | null) => void;
  /** Phase 10E — inspect a remote player from the map (not proximity). */
  onSelectRemote?: (remote: MinimapRemoteMarker) => void;
}

const FILTER_LABELS: { key: keyof MinimapFilters; label: string }[] = [
  { key: 'realPlayers', label: 'Real Players' },
  { key: 'npcs', label: 'NPCs' },
  { key: 'landmarks', label: 'Landmarks' },
  { key: 'missions', label: 'Missions' },
  { key: 'events', label: 'Events' },
  { key: 'districtNames', label: 'District Names' },
];

export function ExpandedWorldMap({
  open,
  onClose,
  live,
  remotes,
  missionLandmarkId,
  onCenterPlayer,
  onDebugUpdate,
  onSelectRemote,
}: ExpandedWorldMapProps) {
  const [filters, setFilters] = useState<MinimapFilters>(() => loadMapFilters());
  const [selected, setSelected] = useState<MinimapLandmark | null>(null);
  const [waypoint, setWaypoint] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    saveMapFilters(filters);
  }, [filters]);

  const toggleFilter = (key: keyof MinimapFilters) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const centerOnPlayer = useCallback(() => {
    setZoom(1);
    onCenterPlayer?.();
  }, [onCenterPlayer]);

  const centerOnMission = useCallback(() => {
    if (!missionLandmarkId) return;
    const lm = DEFAULT_LANDMARKS.find((l) => l.id === missionLandmarkId);
    if (lm) setSelected(lm);
  }, [missionLandmarkId]);

  const handleMapClick = (mx: number, my: number, fit: MapFitRect) => {
    if (filters.realPlayers && onSelectRemote) {
      const remote = hitTestRemote(mx, my, fit, remotes, 'expanded', 0, 0, zoom, 14);
      if (remote) {
        onSelectRemote(remote);
        return;
      }
    }
    const hit = hitTestLandmark(mx, my, fit, DEFAULT_LANDMARKS, 'expanded', 0, 0, zoom, 12);
    if (hit) {
      setSelected(hit);
      return;
    }
    const world = resolveMapClickWorld(mx, my, fit, 'expanded', 0, 0, zoom);
    if (world) setWaypoint(world);
  };

  if (!open) return null;

  return (
    <div
      className="world-map-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded RugTown world map"
      data-ui-block-camera
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="world-map-panel hud-panel" onClick={(e) => e.stopPropagation()}>
        <span className="panel-corner panel-corner--tl" aria-hidden>◆</span>
        <span className="panel-corner panel-corner--tr" aria-hidden>◆</span>
        <span className="panel-corner panel-corner--bl" aria-hidden>◆</span>
        <span className="panel-corner panel-corner--br" aria-hidden>◆</span>

        <div className="panel-header world-map-panel__header">
          <span className="panel-header__logo">WORLD MAP</span>
          <div className="world-map-panel__actions">
            <button type="button" className="world-map-btn" onClick={centerOnPlayer}>Center Player</button>
            {missionLandmarkId && (
              <button type="button" className="world-map-btn" onClick={centerOnMission}>Center Mission</button>
            )}
            <button type="button" className="world-map-btn world-map-btn--close" onClick={onClose} aria-label="Close map">✕</button>
          </div>
        </div>

        <div className="world-map-filters">
          {FILTER_LABELS.map(({ key, label }) => (
            <label key={key} className="world-map-filter">
              <input
                type="checkbox"
                checked={filters[key]}
                onChange={() => toggleFilter(key)}
              />
              {label}
            </label>
          ))}
        </div>

        <div className="world-map-legend" aria-label="Map coverage">
          <span><i className="world-map-legend__building" aria-hidden /> 6 enterable buildings</span>
          <span><i className="world-map-legend__landmark" aria-hidden /> 20 interactive landmarks</span>
        </div>

        <div
          className="world-map-stage"
        >
          <WorldMapCanvas
            className="world-map-stage__canvas"
            mode="expanded"
            live={live}
            remotes={remotes}
            landmarks={DEFAULT_LANDMARKS}
            missionLandmarkId={missionLandmarkId}
            filters={filters}
            selectedLandmarkId={selected?.id ?? null}
            waypoint={waypoint}
            expandedPanX={0}
            expandedPanY={0}
            expandedZoom={zoom}
            showLandmarkLabels={false}
            showDistrictNames={false}
            interactive
            ariaLabel="Expanded world map"
            onClick={handleMapClick}
            onHover={(mx, my, fit) => {
              if (!isInsideMapFit(mx, my, fit)) {
                setHover(null);
                return;
              }
              const w = resolveMapClickWorld(mx, my, fit, 'expanded', 0, 0, zoom);
              setHover(w);
            }}
            onDebugFrame={({ fit, playerMapX, playerMapY, viewport }) => {
              onDebugUpdate?.({
                mapWidth: fit.width,
                mapHeight: fit.height,
                scaleX: fit.worldPerPxX,
                scaleY: fit.worldPerPxY,
                playerMapX,
                playerMapY,
                remoteCount: remotes.length,
                npcCount: live.npcs.length,
                landmarkCount: DEFAULT_LANDMARKS.length,
                viewportMapX: viewport.x,
                viewportMapY: viewport.y,
                viewportMapW: viewport.w,
                viewportMapH: viewport.h,
                selectedLandmarkId: selected?.id ?? null,
                waypoint,
                filters,
              });
            }}
          />
          {hover && (
            <div className="world-map-crosshair" aria-hidden>
              {Math.round(hover.x)}, {Math.round(hover.y)}
            </div>
          )}
        </div>

        {selected && (
          <div className="world-map-inspect">
            <span className="world-map-inspect__icon">{selected.icon}</span>
            <div className="world-map-inspect__body">
              <strong>{selected.name}</strong>
              <span>{selected.districtName}</span>
              <span>{selected.locked ? 'Locked' : selected.live ? 'Interactive' : 'Coming soon'}</span>
              {live.player && (
                <span>
                  {Math.round(Math.hypot(selected.worldX - live.player.x, selected.worldY - live.player.y))} world units away
                </span>
              )}
            </div>
          </div>
        )}

        <p className="world-map-hint">Icons show buildings and landmarks · Click an icon to inspect · Esc to close</p>
      </div>
    </div>
  );
}
