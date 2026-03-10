/**
 * MIDI Engine — DEMOPLAYER adapter
 *
 * Uses MidiPlayerJS for MIDI file parsing/sequencing
 * and a built-in Web Audio GM synth (oscillators) for sound.
 *
 * Progress tracking: uses the 'playing' event from MidiPlayerJS
 * which fires on every tick of the play loop, providing the real
 * current tick. This avoids all bugs related to getCurrentTick()
 * and tempo changes.
 */

/* ─── GM-lite oscillator synth ────────────────────────────────────── */

const PROGRAM_WAVE = [
  'triangle','triangle','triangle','triangle','triangle','triangle','triangle','triangle',
  'sine','sine','sine','sine','sine','sine','sine','sine',
  'sine','sine','sine','sine','sine','sine','sine','sine',
  'sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','sawtooth',
  'sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','sawtooth',
  'sawtooth','sawtooth','sawtooth','sawtooth','sawtooth','triangle','triangle','triangle',
  'sawtooth','sawtooth','sawtooth','sawtooth','square','square','square','square',
  'square','square','square','square','square','square','square','square',
  'square','square','square','square','square','square','square','square',
  'sine','sine','sine','sine','sine','sine','sine','sine',
  'square','sawtooth','sawtooth','triangle','square','square','sawtooth','sawtooth',
  'sawtooth','triangle','sine','sawtooth','triangle','sine','sawtooth','triangle',
  'sine','sine','sine','sine','sine','sine','sine','sine',
  'triangle','triangle','triangle','triangle','triangle','triangle','triangle','triangle',
  'square','square','square','square','square','square','square','square',
  'sine','sine','sine','sine','sine','sine','sine','sine',
];

function midiNoteToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

class MiniGMSynth {
  constructor(ctx, outputNode) {
    this._ctx = ctx;
    this._output = outputNode;
    this._channels = new Array(16).fill(null).map(() => ({
      program: 0, voices: {}, volume: 1, pan: 0,
    }));
  }

  noteOn(channel, note, velocity) {
    if (velocity === 0) { this.noteOff(channel, note); return; }
    const ch = this._channels[channel];
    if (!ch) return;
    if (ch.voices[note]) this._killVoice(ch.voices[note]);

    const ctx = this._ctx;
    const now = ctx.currentTime;
    const isDrum = channel === 9;
    const wave = isDrum ? 'square' : (PROGRAM_WAVE[ch.program] || 'triangle');
    const freq = midiNoteToFreq(note);

    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;
    if (isDrum) osc.detune.value = Math.random() * 100 - 50;

    const env = ctx.createGain();
    const vol = (velocity / 127) * ch.volume * 0.15;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vol, now + 0.01);
    if (isDrum) env.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(env);
    env.connect(this._output);
    osc.start(now);

    if (isDrum) {
      osc.stop(now + 0.2);
      osc.onended = () => { try { osc.disconnect(); env.disconnect(); } catch(e){} };
    } else {
      ch.voices[note] = { osc, env };
    }
  }

  noteOff(channel, note) {
    const ch = this._channels[channel];
    if (!ch || !ch.voices[note]) return;
    this._releaseVoice(ch.voices[note]);
    delete ch.voices[note];
  }

  programChange(channel, program) {
    if (this._channels[channel]) this._channels[channel].program = program;
  }

  controlChange(channel, controller, value) {
    const ch = this._channels[channel];
    if (!ch) return;
    if (controller === 7) ch.volume = value / 127;
    else if (controller === 123 || controller === 120) this.allNotesOff(channel);
  }

  allNotesOff(channel) {
    const ch = this._channels[channel];
    if (!ch) return;
    for (const note in ch.voices) this._killVoice(ch.voices[note]);
    ch.voices = {};
  }

  allSoundsOff() {
    for (let i = 0; i < 16; i++) this.allNotesOff(i);
  }

  _releaseVoice(v) {
    try {
      const now = this._ctx.currentTime;
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setValueAtTime(v.env.gain.value, now);
      v.env.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      v.osc.stop(now + 0.1);
      v.osc.onended = () => { try { v.osc.disconnect(); v.env.disconnect(); } catch(e){} };
    } catch(e) {}
  }

  _killVoice(v) {
    try {
      v.env.gain.cancelScheduledValues(this._ctx.currentTime);
      v.env.gain.setValueAtTime(0, this._ctx.currentTime);
      v.osc.stop(this._ctx.currentTime + 0.005);
      v.osc.onended = () => { try { v.osc.disconnect(); v.env.disconnect(); } catch(e){} };
    } catch(e) {}
  }

  reset() {
    this.allSoundsOff();
    this._channels.forEach(ch => { ch.program = 0; ch.volume = 1; ch.pan = 0; });
  }
}


/* ─── Public MidiEngine API ──────────────────────────────────────── */

export class MidiEngine {
  constructor() {
    this._ctx       = null;
    this._gainNode  = null;
    this._synth     = null;
    this._midiPlayer = null;
    this._ready     = false;
    this._playing   = false;
    this._paused    = false;

    // Progress tracking — from MidiPlayerJS 'playing' event
    this._totalTicks  = 0;
    this._currentTick = 0;
    this._duration    = 0;

    this.onEnded  = null;
    this.onError  = null;
  }

  async init(externalCtx) {
    if (externalCtx && externalCtx.state !== 'closed') {
      this._ctx = externalCtx;
    } else {
      this._ctx = new AudioContext({ sampleRate: 44100 });
    }

    if (typeof MidiPlayer === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = './lib/midi-player.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Cannot load lib/midi-player.js'));
        document.head.appendChild(s);
      });
    }

    this._gainNode = this._ctx.createGain();
    this._gainNode.gain.value = 0.8;
    this._gainNode.connect(this._ctx.destination);

    this._synth = new MiniGMSynth(this._ctx, this._gainNode);
    this._ready = true;
  }

  async loadAndPlay(arrayBuffer, filename) {
    if (!this._ready) await this.init();
    if (this._ctx.state === 'suspended') await this._ctx.resume();

    this.stop();

    const mp = new MidiPlayer.Player();
    this._midiPlayer = mp;

    // ── Synth events ──
    mp.on('midiEvent', (ev) => {
      if (!this._playing) return;
      const ch = ev.channel - 1;
      if      (ev.name === 'Note on')          this._synth.noteOn(ch, ev.noteNumber, ev.velocity);
      else if (ev.name === 'Note off')         this._synth.noteOff(ch, ev.noteNumber);
      else if (ev.name === 'Program Change')   this._synth.programChange(ch, ev.value);
      else if (ev.name === 'Controller Change') this._synth.controlChange(ch, ev.number, ev.value);
    });

    // ── Progress: 'playing' fires every ~5ms with {tick: N} ──
    mp.on('playing', (data) => {
      if (data && typeof data.tick === 'number') {
        this._currentTick = data.tick;
      }
    });

    // ── End of file ──
    mp.on('endOfFile', () => {
      if (!this._playing) return;
      this._synth.allSoundsOff();
      this._playing = false;
      this._paused = false;
      this._currentTick = this._totalTicks;
      if (this.onEnded) this.onEnded();
    });

    // ── Load ──
    try {
      mp.loadArrayBuffer(arrayBuffer);
    } catch(e) {
      const b64 = _arrayBufferToBase64(new Uint8Array(arrayBuffer));
      mp.loadDataUri('data:audio/midi;base64,' + b64);
    }

    // Capture AFTER load (dryRun sets totalTicks)
    this._totalTicks  = mp.totalTicks || 0;
    this._duration    = mp.getSongTime() || 0;
    this._currentTick = 0;

    mp.play();
    this._playing = true;
    this._paused = false;
  }

  stop() {
    this._playing = false;
    this._paused = false;
    if (this._synth) this._synth.allSoundsOff();
    if (this._midiPlayer) {
      try { this._midiPlayer.stop(); } catch(e) {}
      this._midiPlayer = null;
    }
    this._currentTick = 0;
  }

  pause() {
    if (!this._midiPlayer || !this._playing) return;
    this._midiPlayer.pause();
    this._synth.allSoundsOff();
    this._paused = true;
  }

  resume() {
    if (!this._midiPlayer || !this._paused) return;
    if (this._ctx.state === 'suspended') this._ctx.resume();
    this._midiPlayer.play();
    this._paused = false;
  }

  setVolume(v) {
    if (this._gainNode) this._gainNode.gain.value = Math.max(0, Math.min(1, v));
  }

  connectAnalyser(analyser) {
    if (!this._gainNode) return;
    try { this._gainNode.disconnect(); } catch(e) {}
    this._gainNode.connect(analyser);
    analyser.connect(this._ctx.destination);
  }

  silenceGain() {
    if (!this._gainNode || !this._ctx) return;
    this._gainNode.gain.cancelScheduledValues(this._ctx.currentTime);
    this._gainNode.gain.setValueAtTime(0, this._ctx.currentTime);
  }

  restoreGain(vol) {
    if (!this._gainNode || !this._ctx) return;
    this._gainNode.gain.cancelScheduledValues(this._ctx.currentTime);
    this._gainNode.gain.setValueAtTime(vol, this._ctx.currentTime);
  }

  /** Seek to a percentage (0..1) */
  seek(pct) {
    if (!this._midiPlayer) return;
    this._synth.allSoundsOff();
    const wasPlaying = this._playing; // save BEFORE skipToTick calls stop()
    const targetTick = Math.round(Math.max(0, Math.min(1, pct)) * this._totalTicks);
    // skipToTick: calls stop() internally which kills setInterval and resets state
    try { this._midiPlayer.skipToTick(targetTick); } catch(e) {}
    this._currentTick = targetTick;
    // Always restart if we were playing — stop() inside skipToTick may have
    // caused endOfFile to fire in the last playLoop iteration, setting
    // _playing=false before we get here. So use the saved flag.
    if (wasPlaying) {
      this._playing = true; // restore
      try { this._midiPlayer.play(); } catch(e) {}
    }
  }

  get isPlaying()  { return this._playing && !this._paused; }
  get isPaused()   { return this._paused; }
  get duration()   { return this._duration; }
  get totalTicks() { return this._totalTicks; }

  /** Progress 0..1 — from 'playing' event tick data */
  get progress() {
    if (this._totalTicks <= 0) return 0;
    return Math.max(0, Math.min(1, this._currentTick / this._totalTicks));
  }

  /** Current time in seconds — tick progress × duration */
  get currentTime() {
    return this.progress * this._duration;
  }
}

function _arrayBufferToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
