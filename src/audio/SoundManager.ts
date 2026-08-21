/*
  SoundManager.ts
  ───────────────
  RugTown's app-wide audio system.

  Two independent layers:

  1. UI SOUND EFFECTS — synthesized on the Web Audio API (no files, no
     network). Every click / reward / event chime is a short oscillator
     tone. Cheap, instant, and never blocked by autoplay policy once the
     context is unlocked. (Unchanged from the original system.)

  2. BACKGROUND MUSIC — real audio files streamed from /public/audio via
     two crossfading <audio> "decks":
       • city.mp3   — default ambient city loop
       • market.mp3 — Meme Market district loop (optional override)
       • event.mp3  — live-event override loop

     Ambient playback shuffles naturally between the city tracks, never
     repeats the same track twice in a row, and crossfades between them.
     A live event overrides the ambient music with event.mp3; leaving the
     event crossfades back. The Meme Market building can optionally pin
     market.mp3 while the player is there.

  Nothing plays before the first user gesture (unlock()), satisfying the
  browser autoplay policy. Music auto-resumes when a backgrounded tab is
  returned to.
*/

export type SoundChannel = 'music' | 'effects';

export type SoundEffectName =
  | 'click'
  | 'modal'
  | 'reward'
  | 'quest'
  | 'event'
  | 'chatSend'
  | 'bell';

interface TonePreset {
  freq: number;
  freq2?: number;
  duration: number;
  type: OscillatorType;
}

const EFFECT_PRESETS: Record<SoundEffectName, TonePreset> = {
  click:    { freq: 660,    duration: 0.05, type: 'square' },
  modal:    { freq: 440,    freq2: 660,   duration: 0.16, type: 'sine' },
  reward:   { freq: 523,    freq2: 784,   duration: 0.22, type: 'triangle' },
  quest:    { freq: 392,    freq2: 587,   duration: 0.28, type: 'triangle' },
  event:    { freq: 330,    duration: 0.14, type: 'sine' },
  chatSend: { freq: 880,    duration: 0.06, type: 'square' },
  bell:     { freq: 988,    freq2: 1318.5, duration: 0.4, type: 'triangle' },
};

/* ─── Music track catalog ───
   Keys are logical track names; values resolve against Vite's public/
   root (served from the site origin, so they work in dev and prod). */
type MusicTrack = 'city' | 'market' | 'event';

const MUSIC_URLS: Record<MusicTrack, string> = {
  city:   '/audio/city.mp3',
  market: '/audio/market.mp3',
  event:  '/audio/event.mp3',
};

/** Tracks that make up the natural ambient shuffle (event is reserved as
 *  an override, never part of the calm-city rotation). */
const AMBIENT_POOL: MusicTrack[] = ['city', 'market'];

/** Which contextual layer currently owns the music. Priority, high→low:
 *  event  >  market  >  ambient. */
type MusicContext = 'ambient' | 'market' | 'event';

/** Crossfade duration between tracks / contexts, in milliseconds. */
const FADE_MS = 1400;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

class SoundManager {
  /* ── Web Audio (effects only) ── */
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;

  private muted = false;
  private volumes: Record<SoundChannel, number> = {
    music:   0.5,
    effects: 0.35,
  };

  private unlocked = false;

  /** Timestamp (performance.now()) the game world finished loading, set via
   *  notifyGameReady(). Used only to time the initial ambient-music start —
   *  playing music the instant a user's first click/tap unlocks audio felt
   *  abrupt right as the world was still appearing. Null until the game
   *  signals it's ready. */
  private gameReadyAt: number | null = null;
  private ambientArmed = false;
  private static readonly AMBIENT_START_DELAY_MS = 3000;

  /* ── Music decks (two <audio> elements we crossfade between) ── */
  private decks: HTMLAudioElement[] = [];
  private activeDeck = 0;
  private musicContext: MusicContext = 'ambient';
  private marketRequested = false;

  private ambientQueue: MusicTrack[] = [];
  private lastAmbientTrack: MusicTrack | null = null;
  private firstAmbient = true;

  private fadeRaf: number | null = null;
  private lastFadeTs = 0;

  /* ─────────────────────────────────────────────────────────────
     Lifecycle
     ───────────────────────────────────────────────────────────── */

  /** Warm the browser cache for the ambient music tracks so playback can
   *  begin the instant the first user gesture unlocks audio. Creates the
   *  decks and buffers the files — but never calls play(), so it can run at
   *  app startup without violating the autoplay policy. Safe to call once
   *  from the very first screen (landing / auth). */
  preload() {
    this.initMusic();
    // Warm the HTTP cache for the first track only, so playback starts
    // instantly on the first gesture without over-fetching every track up
    // front (market buffers later, during city's minutes-long playback).
    const d0 = this.decks[0];
    if (d0 && !d0.src) { d0.src = MUSIC_URLS.city; try { d0.load(); } catch { /* ignore */ } }
  }

  /** Call once on the first user gesture. Safe to call repeatedly. */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.ensureContext();
    this.ctx?.resume().catch(() => {});
    this.initMusic();
    // Honour whatever higher-priority context was requested before the
    // gesture landed (a live event or standing at the market) -- those
    // start immediately, same as before. The default ambient case is the
    // only one that gets the delayed start (see armAmbientStart below).
    if (this.musicContext === 'event') this.crossfadeTo('event', true);
    else if (this.musicContext === 'market') this.crossfadeTo('market', true);
    else this.armAmbientStart();
  }

  /** Call once when the game world has finished loading. Only affects the
   *  timing of the very first ambient-music start (see AMBIENT_START_DELAY_MS
   *  above) -- has no effect on event/market overrides, which always play
   *  immediately when requested. Safe to call more than once. */
  notifyGameReady() {
    if (this.gameReadyAt != null) return;
    this.gameReadyAt = performance.now();
    // If the player already unlocked audio (e.g. clicked something on the
    // homepage) before the world finished loading, arm the delayed start
    // now that we actually know when "loaded" happened.
    if (this.unlocked && this.musicContext === 'ambient') this.armAmbientStart();
  }

  /** Starts the ambient shuffle ~AMBIENT_START_DELAY_MS after the game
   *  finished loading (or after this fires, if the game hasn't reported
   *  ready yet -- e.g. a homepage click before the world exists). Idempotent. */
  private armAmbientStart() {
    if (this.ambientArmed) return;
    this.ambientArmed = true;
    const elapsed = this.gameReadyAt != null ? performance.now() - this.gameReadyAt : 0;
    const wait = Math.max(0, SoundManager.AMBIENT_START_DELAY_MS - elapsed);
    setTimeout(() => {
      // Only start ambient if nothing higher-priority took over meanwhile.
      if (this.musicContext === 'ambient') this.startAmbientShuffle();
    }, wait);
  }

  isMuted(): boolean { return this.muted; }
  isUnlocked(): boolean { return this.unlocked; }

  setMuted(muted: boolean) {
    this.muted = muted;
    // Effects layer.
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
    }
    // Music layer — active deck jumps to the (un)muted target unless a
    // crossfade is already animating volumes.
    this.applyMusicVolume();
  }

  getVolume(channel: SoundChannel): number { return this.volumes[channel]; }

  setVolume(channel: SoundChannel, volume: number) {
    const v = clamp01(volume);
    this.volumes[channel] = v;
    if (channel === 'music') {
      this.applyMusicVolume();
    } else if (this.ctx && this.effectsGain) {
      this.effectsGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     UI sound effects (synthesized)
     ───────────────────────────────────────────────────────────── */

  play(name: SoundEffectName) {
    if (!this.unlocked) return;
    this.ensureContext();
    const ctx = this.ctx;
    const destination = this.effectsGain;
    if (!ctx || !destination) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const preset = EFFECT_PRESETS[name];
    this.playTone(preset.freq, preset.duration, preset.type, destination);
    if (preset.freq2) {
      setTimeout(() => {
        if (this.ctx && destination) this.playTone(preset.freq2!, preset.duration, preset.type, destination);
      }, preset.duration * 500);
    }
  }

  private ensureContext() {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 1;
    master.connect(ctx.destination);

    const effects = ctx.createGain();
    effects.gain.value = this.volumes.effects;
    effects.connect(master);

    this.ctx = ctx;
    this.masterGain = master;
    this.effectsGain = effects;
  }

  private playTone(freq: number, duration: number, type: OscillatorType, destination: GainNode, vol = 0.55) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(vol, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /* ─────────────────────────────────────────────────────────────
     Background music (file-based, crossfaded)
     ───────────────────────────────────────────────────────────── */

  /** Switch the music to (or away from) the live-event override.
   *  Event music has the highest priority — it overrides city/market. */
  setEventMusic(active: boolean) {
    if (active) {
      if (this.musicContext === 'event') return;
      this.musicContext = 'event';
      if (this.unlocked) this.crossfadeTo('event', true);
    } else {
      if (this.musicContext !== 'event') return;
      // Leaving the event: fall back to market if still requested, else the
      // ambient city shuffle.
      if (this.marketRequested) {
        this.musicContext = 'market';
        if (this.unlocked) this.crossfadeTo('market', true);
      } else {
        this.startAmbientShuffle();
      }
    }
  }

  /** Optionally pin the Meme Market loop while the player is at the market
   *  building. Ignored while an event override is active (resumes once the
   *  event ends). */
  setMarketMusic(active: boolean) {
    this.marketRequested = active;
    if (this.musicContext === 'event') return; // event keeps priority

    if (active) {
      if (this.musicContext === 'market') return;
      this.musicContext = 'market';
      if (this.unlocked) this.crossfadeTo('market', true);
    } else if (this.musicContext === 'market') {
      this.startAmbientShuffle();
    }
  }

  private initMusic() {
    if (this.decks.length) return;
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = 'auto';
      el.volume = 0;
      el.addEventListener('ended', () => this.handleTrackEnded(i));
      this.decks.push(el);
    }
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  /** Ambient (non-looping) tracks fire 'ended' → advance the shuffle.
   *  Looping context tracks (event/market) never reach here. */
  private handleTrackEnded(deckIdx: number) {
    if (deckIdx === this.activeDeck && this.musicContext === 'ambient') {
      this.playNextAmbient();
    }
  }

  /** Pause when the tab is hidden; resume the active deck when it returns
   *  (browsers throttle/suspend background media). */
  private handleVisibility = () => {
    if (!this.unlocked) return;
    const deck = this.decks[this.activeDeck];
    if (!deck) return;
    if (document.hidden) {
      deck.pause();
    } else {
      deck.play().catch(() => {});
    }
  };

  private startAmbientShuffle() {
    this.musicContext = 'ambient';
    this.playNextAmbient();
  }

  private playNextAmbient() {
    // The very first ambient track is always the preloaded city loop, so
    // music starts instantly from warm cache; everything after shuffles.
    let track: MusicTrack;
    if (this.firstAmbient) {
      this.firstAmbient = false;
      track = 'city';
    } else {
      track = this.nextAmbientTrack();
    }
    this.lastAmbientTrack = track;
    this.crossfadeTo(track, false);
  }

  /** Draw the next ambient track from a reshuffled queue, guaranteeing the
   *  same track never plays twice in a row (even across queue refills). */
  private nextAmbientTrack(): MusicTrack {
    if (this.ambientQueue.length === 0) {
      const shuffled = [...AMBIENT_POOL];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Avoid repeating the last-played track across the refill boundary.
      if (shuffled.length > 1 && shuffled[0] === this.lastAmbientTrack) {
        [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
      }
      this.ambientQueue = shuffled;
    }
    return this.ambientQueue.shift()!;
  }

  /** Load a track onto the inactive deck, start it, and crossfade the two
   *  decks. `loop` is true for context overrides (event/market) that should
   *  play until their context changes, false for ambient tracks that hand
   *  off to the next shuffle entry when they end. */
  private crossfadeTo(track: MusicTrack, loop: boolean) {
    if (!this.unlocked || this.decks.length < 2) return;
    const nextIdx = 1 - this.activeDeck;
    const incoming = this.decks[nextIdx];

    incoming.src = MUSIC_URLS[track];
    incoming.loop = loop;
    incoming.currentTime = 0;
    incoming.volume = 0;
    incoming.play().catch(() => {});

    this.activeDeck = nextIdx;
    this.startFade();
  }

  /** Immediately set the active deck to the current effective volume when no
   *  crossfade is animating (used by volume-slider / mute changes). */
  private applyMusicVolume() {
    if (this.fadeRaf != null) return; // fade loop already drives volumes
    const deck = this.decks[this.activeDeck];
    if (deck) deck.volume = this.effectiveMusicVolume();
  }

  private effectiveMusicVolume(): number {
    return this.muted ? 0 : clamp01(this.volumes.music);
  }

  /** rAF-driven crossfade: ramp the active deck up to the effective music
   *  volume and every other deck down to 0 (then pause it). Re-reads the
   *  effective volume each frame so live slider/mute changes are respected. */
  private startFade() {
    this.lastFadeTs = performance.now();
    if (this.fadeRaf != null) return;

    const step = (ts: number) => {
      const dt = ts - this.lastFadeTs;
      this.lastFadeTs = ts;
      const target = this.effectiveMusicVolume();
      const maxDelta = dt / FADE_MS; // full 0→1 sweep across FADE_MS
      let stillFading = false;

      this.decks.forEach((deck, i) => {
        const goal = i === this.activeDeck ? target : 0;
        const cur = deck.volume;
        let next = cur;
        if (cur < goal) next = Math.min(goal, cur + maxDelta);
        else if (cur > goal) next = Math.max(goal, cur - maxDelta);
        deck.volume = clamp01(next);

        if (Math.abs(deck.volume - goal) > 0.001) {
          stillFading = true;
        } else if (i !== this.activeDeck && deck.volume <= 0.001 && !deck.paused) {
          deck.pause();
        }
      });

      this.fadeRaf = stillFading ? requestAnimationFrame(step) : null;
    };

    this.fadeRaf = requestAnimationFrame(step);
  }
}

/** Single shared instance — sound is an app-wide concern, not per-component. */
export const soundManager = new SoundManager();
