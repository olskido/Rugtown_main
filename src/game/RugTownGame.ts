import Phaser from 'phaser';
import { WorldScene } from './scenes/WorldScene';
import { InteriorScene } from './scenes/InteriorScene';
import { AssetGalleryScene } from './scenes/AssetGalleryScene';
import { isAssetGalleryRequested } from './assets/WorldAssetManifest';
import type { CharacterAppearanceV1 } from './characters/appearance/CharacterAppearanceDefaults';

/*
  RugTownGame.ts
  ──────────────
  Creates and manages the Phaser.Game instance.
  Designed to be instantiated by GamePage.tsx and destroyed on unmount.

  - Default: WorldScene + InteriorScene (+ AssetGalleryScene registered for F8)
  - Dev QA: ?assetGallery=1 boots AssetGalleryScene only
*/

export interface RugTownGameConfig {
  /** DOM element ID to mount the canvas inside */
  parentId: string;
  /** Bitmap appearance chosen on the pre-game character-creator screen. */
  appearance?: CharacterAppearanceV1;
  /** Called when the scene is ready */
  onReady?: (scene: WorldScene) => void;
  /** Force Asset Gallery boot (overrides URL when set). */
  assetGallery?: boolean;
}

export class RugTownGame {
  private game: Phaser.Game;
  private worldScene: WorldScene;
  private interiorScene: InteriorScene;
  private assetGalleryScene: AssetGalleryScene;
  readonly galleryMode: boolean;

  constructor(config: RugTownGameConfig) {
    this.worldScene = new WorldScene();
    this.interiorScene = new InteriorScene();
    this.assetGalleryScene = new AssetGalleryScene();
    this.galleryMode = config.assetGallery === true || isAssetGalleryRequested();

    // Set before the scene's create() ever runs, so the player's first
    // draw already uses the chosen appearance.
    if (config.appearance) this.worldScene.setAppearance(config.appearance);

    // Wire the ready callback BEFORE Phaser boots — WorldScene fires it
    // after all NPCs are spawned, not at the raw create() return point.
    // This keeps the loading screen visible until the city is fully
    // populated so the player's first frame is guaranteed to be smooth.
    if (config.onReady && !this.galleryMode) {
      this.worldScene.setOnReadyCallback(config.onReady);
    }

    this.game = new Phaser.Game({
      type: Phaser.AUTO,            // WebGL with Canvas fallback
      parent: config.parentId,      // Mount inside this DOM element

      // Fill the parent container — GamePage controls sizing via CSS
      width:  '100%',
      height: '100%',

      // Transparent so any React elements layered behind show through
      backgroundColor: '#050c10',

      // Canvas anti-aliasing off; roundPixels keeps sprites/text from
      // landing on half-pixels (a common blur source on mobile DPR).
      antialias: false,
      pixelArt: false,

      render: {
        powerPreference: 'high-performance',
        roundPixels: true,
        antialias: false,
        pixelArt: false,
      },

      // Delta smoothing (smoothStep) averages frame delta over recent
      // frames, so a brief startup hitch ramps gradually instead of
      // producing a sudden speed lurch. fps.min is left at the Phaser
      // default so WorldScene's own 100ms delta clamp stays the single
      // authority on the low-FPS movement floor.
      fps: {
        target: 60,
        smoothStep: true,
      },

      // Resize to parent
      scale: {
        mode:       Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },

      // Gallery-only boot skips the live world; otherwise register gallery
      // for F8 without starting it.
      scene: this.galleryMode
        ? [this.assetGalleryScene]
        : [this.worldScene, this.interiorScene, this.assetGalleryScene],

      // No physics for world view
      physics: {
        default: 'arcade',
        arcade:  { debug: false, gravity: { x: 0, y: 0 } },
      },

      // Performance: don't pause when tab is hidden
      autoFocus: true,
      disableContextMenu: true,
    });
  }

  /** Access the world scene directly */
  getWorldScene(): WorldScene {
    return this.worldScene;
  }

  /** Clean up — call on React component unmount */
  destroy() {
    this.game.destroy(true, false);
  }

  /** Resize canvas to match container — called on window resize */
  resize() {
    // Phaser RESIZE mode handles this automatically,
    // but this hook is here if manual override is needed.
    this.game.scale.refresh();
  }
}
