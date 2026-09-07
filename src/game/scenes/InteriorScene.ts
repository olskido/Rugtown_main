import Phaser from 'phaser';
import { queueCharacterBitmapLoads } from '../characters/assets/CharacterAssetLoader';
import { hydrateCharacterRegistryFromScene, assetExists } from '../characters/assets/CharacterAssetRegistry';
import { BitmapCharacter } from '../characters/render/BitmapCharacter';
import { PLAYER_VISUAL_SCALE } from '../characters/render/CharacterVisualScale';
import type { CharacterAppearanceV1 } from '../characters/appearance/CharacterAppearanceDefaults';
import { getDefaultCharacterAppearance } from '../characters/appearance/CharacterAppearanceDefaults';
import { decodeCharacterAppearance } from '../characters/appearance/CharacterAppearanceCodec';
import type { Direction } from '../characters/animation/CharacterDirection';
import { getEnterableBuilding, type EnterableBuilding } from '../world/EnterableBuildings';

const ROOM_W = 1280;
const ROOM_H = 720;
const PLAYER_SPEED = 243;
const PLAYER_DIAG = 0.7071;
const INTERACT_RADIUS = 88;
const CHAR_W = 22;
const CHAR_H = 34;
const DECOR_GOLD = 0xe8b84b;
const DECOR_GOLD_DIM = 0xc8902a;
const BG_DARK = 0x070b0f;
const BG_MID = 0x10161d;
const FLOOR_DARK = 0x0d141a;
const WALL = 0x141b22;

type InteriorPrompt =
  | { kind: 'exit'; label: string }
  | { kind: 'feature'; label: string };

export interface InteriorSceneData {
  buildingId: string;
  appearance?: CharacterAppearanceV1;
}

export class InteriorScene extends Phaser.Scene {
  private building: EnterableBuilding | null = null;
  private px = 640;
  private py = 560;
  private velX = 0;
  private velY = 0;
  private facing: Direction = 'down';
  private isMoving = false;
  private animTick = 0;
  private lastDeltaMs = 16;
  private bitmapPlayer: BitmapCharacter | null = null;
  private playerGlow!: Phaser.GameObjects.Graphics;
  private playerLabel!: Phaser.GameObjects.Text;
  private playerSpeech!: Phaser.GameObjects.Text;
  private playerSpeechUntil = 0;
  private appearance: CharacterAppearanceV1 = getDefaultCharacterAppearance();
  private keyW!: Phaser.Input.Keyboard.Key;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyS!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyUp!: Phaser.Input.Keyboard.Key;
  private keyDown!: Phaser.Input.Keyboard.Key;
  private keyLeft!: Phaser.Input.Keyboard.Key;
  private keyRight!: Phaser.Input.Keyboard.Key;
  private keyE!: Phaser.Input.Keyboard.Key;
  private virtualMoveX = 0;
  private virtualMoveY = 0;
  private virtualInteractRequested = false;
  private nearPrompt: InteriorPrompt | null = null;
  private rewardTexts: { obj: Phaser.GameObjects.Text; vy: number; life: number; maxLife: number }[] = [];

  constructor() {
    super('InteriorScene');
  }

  init(data: InteriorSceneData) {
    this.building = getEnterableBuilding(data.buildingId) ?? null;
    this.appearance = decodeCharacterAppearance(data.appearance, assetExists);
    if (this.building) {
      this.px = this.building.spawnPosition.x;
      this.py = this.building.spawnPosition.y;
    }
  }

  preload() {
    // Skip queue when WorldScene (or another scene) already loaded atlases.
    if (!this.textures.exists('char-atlas-atlas_hair')) {
      queueCharacterBitmapLoads(this);
    }
  }

  create() {
    hydrateCharacterRegistryFromScene(this);
    this.cameras.main.setBackgroundColor('#05080c');
    this.cameras.main.setBounds(0, 0, ROOM_W, ROOM_H);
    this.fitInteriorCamera();
    this.scale.on('resize', this.fitInteriorCamera, this);

    this.drawRoom();
    this.setupInput();

    this.playerGlow = this.add.graphics().setDepth(18);
    this.bitmapPlayer = new BitmapCharacter(this, this.appearance, {
      depth: 20,
      visualScale: PLAYER_VISUAL_SCALE,
    });
    this.bitmapPlayer.setPosition(this.px, this.py);
    this.bitmapPlayer.setFacing(this.facing);

    this.playerLabel = this.add.text(0, 0, 'You', {
      fontFamily: '"Cinzel", serif',
      fontSize: '14px',
      fontStyle: 'bold',
      color: '#ffe88a',
      backgroundColor: 'rgba(4,8,12,0.94)',
      padding: { x: 6, y: 3 },
      stroke: '#000000',
      strokeThickness: 5,
      resolution: 2,
    }).setOrigin(0.5, 1).setDepth(21);
    this.playerSpeech = this.add.text(0, 0, '', {
      fontFamily: '"Cinzel", serif',
      fontSize: '12px',
      color: '#e8d8c0',
      backgroundColor: 'rgba(10,14,18,0.94)',
      padding: { x: 7, y: 4 },
      stroke: '#000000',
      strokeThickness: 3,
      align: 'center',
      resolution: 2,
    }).setOrigin(0.5, 1).setDepth(22).setVisible(false);

    this.drawPlayer();
    this.registry.set('interiorState', {
      active: true,
      buildingId: this.building?.id ?? null,
      displayName: this.building?.displayName ?? 'Interior',
    });
    this.registry.set('nearInteriorPrompt', null);
  }

  update(_time: number, delta: number) {
    const dt = Math.min(delta, 100) / 1000;
    this.lastDeltaMs = Math.min(delta, 100);
    this.animTick += delta;

    const left = this.keyA.isDown || this.keyLeft.isDown;
    const right = this.keyD.isDown || this.keyRight.isDown;
    const up = this.keyW.isDown || this.keyUp.isDown;
    const down = this.keyS.isDown || this.keyDown.isDown;

    let vx = 0;
    let vy = 0;
    if (left) vx -= PLAYER_SPEED;
    if (right) vx += PLAYER_SPEED;
    if (up) vy -= PLAYER_SPEED;
    if (down) vy += PLAYER_SPEED;
    if (vx !== 0 && vy !== 0) {
      vx *= PLAYER_DIAG;
      vy *= PLAYER_DIAG;
    }
    if (this.virtualMoveX !== 0 || this.virtualMoveY !== 0) {
      vx = this.virtualMoveX * PLAYER_SPEED;
      vy = this.virtualMoveY * PLAYER_SPEED;
    }
    this.velX = vx;
    this.velY = vy;

    const pad = 92;
    const nx = Phaser.Math.Clamp(this.px + vx * dt, pad, ROOM_W - pad);
    const ny = Phaser.Math.Clamp(this.py + vy * dt, 150, ROOM_H - 96);
    this.isMoving = Math.abs(nx - this.px) > 0.1 || Math.abs(ny - this.py) > 0.1;
    this.px = nx;
    this.py = ny;

    if (Math.abs(vx) >= Math.abs(vy) && Math.abs(vx) > 8) {
      this.facing = vx > 0 ? 'right' : 'left';
    } else if (Math.abs(vy) > 8) {
      this.facing = vy > 0 ? 'down' : 'up';
    }

    this.updatePrompt();
    this.drawPlayer();
    this.updateRewardTexts(delta);

    if (this.playerSpeechUntil > 0) {
      this.playerSpeechUntil -= delta;
      if (this.playerSpeechUntil <= 0) this.playerSpeech.setVisible(false);
    }
  }

  shutdownInterior() {
    this.scale.off('resize', this.fitInteriorCamera, this);
    this.registry.set('interiorState', { active: false, buildingId: null, displayName: null });
    this.registry.set('nearInteriorPrompt', null);
  }

  setKeyboardEnabled(enabled: boolean) {
    const kb = this.input.keyboard;
    if (!kb) return;
    kb.enabled = enabled;
    if (enabled) kb.resetKeys();
  }

  setVirtualMove(x: number, y: number) {
    this.virtualMoveX = Phaser.Math.Clamp(x, -1, 1);
    this.virtualMoveY = Phaser.Math.Clamp(y, -1, 1);
  }

  requestInteract() {
    this.virtualInteractRequested = true;
  }

  setAppearance(appearance: unknown) {
    this.appearance = decodeCharacterAppearance(appearance, assetExists);
    this.bitmapPlayer?.setAppearance(this.appearance);
    if (this.bitmapPlayer) this.drawPlayer();
  }

  private fitInteriorCamera() {
    const camera = this.cameras.main;
    const viewportWidth = Math.max(1, this.scale.width);
    const viewportHeight = Math.max(1, this.scale.height);
    const fitZoom = Math.min(
      viewportWidth / ROOM_W,
      viewportHeight / ROOM_H,
    ) * 0.94;
    const zoom = Phaser.Math.Clamp(fitZoom, 0.42, 1);
    camera.setZoom(zoom);
    camera.centerOn(ROOM_W / 2, ROOM_H / 2);
  }

  showPlayerSpeech(text: string, duration = 3000) {
    this.playerSpeech.setText(text);
    this.playerSpeech.setVisible(true);
    this.playerSpeechUntil = duration;
  }

  playEmoteAnimation() {
    const targets: Phaser.GameObjects.GameObject[] = [this.playerGlow];
    if (this.bitmapPlayer) targets.push(this.bitmapPlayer.root);
    this.tweens.add({
      targets,
      scaleX: 1.08,
      scaleY: 1.08,
      duration: 140,
      yoyo: true,
      ease: 'Sine.easeInOut',
    });
  }

  playRewardEffect(text: string) {
    const obj = this.add.text(this.px, this.py - CHAR_H - 34, text, {
      fontFamily: '"Cinzel", serif',
      fontSize: '18px',
      fontStyle: 'bold',
      color: '#ffe88a',
      stroke: '#000000',
      strokeThickness: 5,
      backgroundColor: 'rgba(8,12,16,0.85)',
      padding: { x: 8, y: 4 },
      resolution: 2,
    }).setOrigin(0.5).setDepth(40);
    this.rewardTexts.push({ obj, vy: -28, life: 900, maxLife: 900 });
  }

  private setupInput() {
    const kb = this.input.keyboard;
    if (!kb) return;
    this.keyW = kb.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyS = kb.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyUp = kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.keyDown = kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keyLeft = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    this.keyE = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E);
  }

  private consumeInteractPress(): boolean {
    if (Phaser.Input.Keyboard.JustDown(this.keyE)) return true;
    if (this.virtualInteractRequested) {
      this.virtualInteractRequested = false;
      return true;
    }
    return false;
  }

  private updatePrompt() {
    const exitPos = { x: ROOM_W / 2, y: ROOM_H - 118 };
    const featurePos = { x: ROOM_W / 2, y: 208 };
    const exitNear = Phaser.Math.Distance.Between(this.px, this.py, exitPos.x, exitPos.y) <= INTERACT_RADIUS;
    const featureNear = Phaser.Math.Distance.Between(this.px, this.py, featurePos.x, featurePos.y) <= INTERACT_RADIUS;

    let prompt: InteriorPrompt | null = null;
    if (exitNear) prompt = { kind: 'exit', label: `Exit ${this.building?.displayName ?? 'Interior'}` };
    else if (featureNear) prompt = { kind: 'feature', label: this.building?.featureLabel ?? 'Inspect' };

    if ((prompt?.kind ?? null) !== (this.nearPrompt?.kind ?? null) || (prompt?.label ?? '') !== (this.nearPrompt?.label ?? '')) {
      this.nearPrompt = prompt;
      this.registry.set('nearInteriorPrompt', prompt);
    }

    if (!prompt || !this.consumeInteractPress()) return;

    if (prompt.kind === 'exit') {
      this.events.emit('interior-exit', { buildingId: this.building?.id ?? null });
    } else {
      this.showPlayerSpeech(this.featureSpeech());
      this.events.emit('interior-feature', {
        buildingId: this.building?.id ?? null,
        label: prompt.label,
      });
    }
  }

  private featureSpeech(): string {
    switch (this.building?.interiorType) {
      case 'coffee_shop': return 'Fresh alpha and hotter coffee.';
      case 'alpha_lounge': return 'Signal room is warm. Keep your size sane.';
      case 'meme_market': return 'Tickers are wild today.';
      case 'hall_of_fame': return 'Legends leave footprints here.';
      default: return 'Something useful will live here soon.';
    }
  }

  private drawRoom() {
    const g = this.add.graphics().setDepth(0);
    g.fillGradientStyle(BG_DARK, BG_DARK, BG_MID, BG_MID, 1);
    g.fillRect(0, 0, ROOM_W, ROOM_H);

    g.fillStyle(FLOOR_DARK, 1);
    g.fillRect(64, 110, ROOM_W - 128, ROOM_H - 180);
    g.lineStyle(4, DECOR_GOLD_DIM, 0.55);
    g.strokeRect(64, 110, ROOM_W - 128, ROOM_H - 180);

    g.fillStyle(WALL, 1);
    g.fillRect(64, 72, ROOM_W - 128, 54);
    g.fillRect(64, ROOM_H - 96, ROOM_W - 128, 32);
    g.fillRect(64, 72, 32, ROOM_H - 136);
    g.fillRect(ROOM_W - 96, 72, 32, ROOM_H - 136);

    g.fillStyle(DECOR_GOLD, 0.12);
    for (let y = 150; y < ROOM_H - 110; y += 46) {
      g.fillRect(110, y, ROOM_W - 220, 2);
    }

    this.drawDoor(g, ROOM_W / 2, ROOM_H - 104, 'EXIT');
    this.drawInteriorFeature(g);

    const title = this.add.text(ROOM_W / 2, 92, this.building?.roomLabel ?? 'Interior', {
      fontFamily: '"Cinzel", serif',
      fontSize: '26px',
      fontStyle: 'bold',
      color: '#ffe88a',
      stroke: '#000000',
      strokeThickness: 6,
      backgroundColor: 'rgba(6,10,14,0.88)',
      padding: { x: 12, y: 6 },
      resolution: 2,
    }).setOrigin(0.5, 0.5).setDepth(10);

    this.tweens.add({
      targets: title,
      alpha: 0.76,
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private drawDoor(g: Phaser.GameObjects.Graphics, x: number, y: number, label: string) {
    g.fillStyle(0x1b1108, 1);
    g.fillRect(x - 44, y - 72, 88, 72);
    g.fillStyle(DECOR_GOLD_DIM, 0.85);
    g.fillRect(x - 50, y - 78, 100, 78);
    g.fillStyle(0x0a0f14, 1);
    g.fillRect(x - 42, y - 70, 84, 70);
    g.fillStyle(DECOR_GOLD, 0.2);
    g.fillRect(x - 4, y - 68, 8, 66);
    this.add.text(x, y - 88, label, {
      fontFamily: '"Cinzel", serif',
      fontSize: '13px',
      fontStyle: 'bold',
      color: '#e8b84b',
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5).setDepth(9);
  }

  private drawInteriorFeature(g: Phaser.GameObjects.Graphics) {
    const x = ROOM_W / 2;
    const y = 190;
    switch (this.building?.interiorType) {
      case 'coffee_shop':
        g.fillStyle(0x20160d, 1);
        g.fillRect(x - 160, y - 30, 320, 58);
        g.fillStyle(DECOR_GOLD, 0.25);
        g.fillRect(x - 160, y - 34, 320, 6);
        g.fillStyle(0x3a2612, 1);
        g.fillCircle(x - 80, y - 10, 18);
        g.fillCircle(x + 10, y - 12, 14);
        g.fillCircle(x + 92, y - 8, 16);
        this.drawNpcSilhouette(x - 260, y + 50, 'BARISTA');
        break;
      case 'alpha_lounge':
        g.fillStyle(0x151a20, 1);
        g.fillRoundedRect(x - 170, y - 36, 340, 72, 14);
        g.fillStyle(DECOR_GOLD, 0.16);
        g.fillRect(x - 170, y - 40, 340, 8);
        for (let i = -2; i <= 2; i++) {
          g.fillStyle(DECOR_GOLD, 0.18 + Math.abs(i) * 0.03);
          g.fillRect(x + i * 56 - 20, y - 10, 40, 20);
        }
        this.drawNpcSilhouette(x + 250, y + 48, 'ANALYST');
        break;
      case 'meme_market':
        for (let i = -2; i <= 2; i++) {
          g.fillStyle(0x1a1410, 1);
          g.fillRect(x + i * 92 - 34, y - 26, 68, 52);
          g.fillStyle(DECOR_GOLD, 0.22);
          g.fillRect(x + i * 92 - 34, y - 30, 68, 6);
        }
        this.drawNpcSilhouette(x - 250, y + 50, 'TRADER');
        break;
      case 'hall_of_fame':
        g.fillStyle(0x12161b, 1);
        g.fillRect(x - 180, y - 18, 360, 36);
        for (let i = -1; i <= 1; i++) {
          g.fillStyle(0x2a2f36, 1);
          g.fillRect(x + i * 110 - 32, y - 88, 64, 70);
          g.fillStyle(DECOR_GOLD, 0.22);
          g.fillRect(x + i * 110 - 36, y - 94, 72, 8);
        }
        break;
      default:
        g.fillStyle(0x171d22, 1);
        g.fillRoundedRect(x - 160, y - 32, 320, 64, 16);
        break;
    }

    this.add.text(x, y + 52, this.building?.featureLabel ?? 'Feature', {
      fontFamily: '"Cinzel", serif',
      fontSize: '14px',
      fontStyle: 'bold',
      color: '#d7b46a',
      backgroundColor: 'rgba(4,8,12,0.84)',
      padding: { x: 10, y: 4 },
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5).setDepth(12);
  }

  private drawNpcSilhouette(x: number, y: number, label: string) {
    const g = this.add.graphics().setDepth(11);
    g.fillStyle(0x1b232b, 1);
    g.fillCircle(x, y - 34, 14);
    g.fillRoundedRect(x - 18, y - 22, 36, 52, 10);
    g.fillStyle(DECOR_GOLD, 0.18);
    g.fillRect(x - 10, y - 6, 20, 5);
    this.add.text(x, y + 40, label, {
      fontFamily: '"Cinzel", serif',
      fontSize: '12px',
      color: '#c8a35c',
      stroke: '#000000',
      strokeThickness: 4,
      resolution: 2,
    }).setOrigin(0.5).setDepth(12);
  }

  private drawPlayer() {
    if (!this.bitmapPlayer) return;

    this.bitmapPlayer.setPosition(this.px, this.py);
    this.bitmapPlayer.setFacing(this.facing);
    this.bitmapPlayer.update(this.lastDeltaMs, this.velX, this.velY, this.isMoving);

    this.playerGlow.clear();
    this.playerGlow.fillStyle(0xe8b84b, 0.08);
    this.playerGlow.fillEllipse(this.px, this.py - 6, CHAR_W + 20, CHAR_H + 12);

    this.playerLabel.setPosition(this.px, this.py - CHAR_H * 0.9);
    this.playerSpeech.setPosition(this.px, this.py - CHAR_H - 26);
  }

  private updateRewardTexts(delta: number) {
    for (let i = this.rewardTexts.length - 1; i >= 0; i--) {
      const item = this.rewardTexts[i];
      item.life -= delta;
      item.obj.y += item.vy * (delta / 1000);
      item.obj.setAlpha(Math.max(0, item.life / item.maxLife));
      if (item.life <= 0) {
        item.obj.destroy();
        this.rewardTexts.splice(i, 1);
      }
    }
  }
}
