/**
 * V2M Worklet Engine — DEMOPLAYER adapter
 *
 * Wraps the Juergen Wothke farbrausch V2 AudioWorklet backend
 * into a simple API compatible with the DEMOPLAYER player.js.
 *
 * Usage:
 *   const v2m = new V2mEngine();
 *   await v2m.init();                        // load worklet module once
 *   v2m.onEnded = () => { ... };
 *   await v2m.loadAndPlay(arrayBuffer, name);
 *   v2m.stop();
 *   v2m.setVolume(0..1);
 *   v2m.connectAnalyser(analyserNode);       // optional — for visualizer
 */

/* ─── Extended AudioWorkletNode (comm bridge to the processor) ─── */
class V2mWorkletNode extends AudioWorkletNode {
  constructor(ctx, processorName, onMessage) {
    super(ctx, processorName, { outputChannelCount: [2] });
    this.port.onmessage = (ev) => onMessage(ev.data);
    this._wasmReadyCb = null;
  }

  /* turn async postMessage into a synchronous-looking call via SharedArrayBuffer */
  _syncCall(msg) {
    const sab   = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    int32[0] = -666;
    msg.ret = sab;
    this.port.postMessage(msg);
    // busy-wait (Atomics.wait is blocked on the UI thread — this is the only option)
    while (Atomics.load(int32, 0) === -666) { /* spin */ }
    return int32[0];
  }

  loadMusicData(sampleRate, path, filename, data) {
    return this._syncCall({ message: 'loadMusicData', sampleRate, path, filename, data, options: {} });
  }
  evalTrackOptions() {
    return this._syncCall({ message: 'evalTrackOptions', options: { track: -1 } });
  }
  play()     { this._syncCall({ message: 'play' });     }
  pause()    { this._syncCall({ message: 'pause' });    }
  teardown() { this._syncCall({ message: 'teardown' }); }

  getNumberTraceStreams() {
    return this._syncCall({ message: 'getNumberTraceStreams' });
  }


  setSharedScopeBuffers(bufs) {
    return this._syncCall({ message: 'setSharedScopeBuffers', scopeBuffers: bufs });
  }

  /* Request an async duration probe. The processor runs chunked decoding
     and replies with 'probeDurationResult'. Returns the reqId for routing. */
  requestProbeDuration(filename, data, sampleRate, reqId) {
    this.port.postMessage({
      message:    'probeDuration',
      filename:   filename,
      data:       data,
      sampleRate: sampleRate,
      reqId:      reqId,
    });
  }
}


/* ─── Public API ─── */
export class V2mEngine {
  constructor() {
    this._ctx         = null;
    this._node        = null;
    this._gainNode    = null;
    this._ready          = false;
    this._playing        = false;
    this._duration       = 0;
    this._probeCallbacks = {};    // reqId -> resolve fn for probeDuration Promises
    this._probeReqId     = 0;
    this._activeIdx      = -1;    // playlist index of the currently playing track
    this._processorFile = './lib/v2m-processor46.js';
    this._processorName = 'v2m-processor';

    this.onEnded  = null;   // callback: () => void
    this.onError  = null;   // callback: (msg) => void
  }

  /* ── init(ctx?): call once, resolves when the AudioWorklet module is loaded.
        Pass an existing AudioContext to share it with the main audio graph.    ── */
  async init(externalCtx) {
    // Prefer the shared context so all nodes live in the same graph
    if (externalCtx && externalCtx.state !== 'closed') {
      this._ctx = externalCtx;
    } else if (!this._ctx || this._ctx.state === 'closed') {
      this._ctx = new AudioContext({ sampleRate: 44100 });
    }

    if (this._ready) return;   // already initialised

    await this._ctx.audioWorklet.addModule(this._processorFile, { credentials: 'omit' });

    // wait for the WASM inside the processor to finish loading
    await new Promise((resolve, reject) => {
      const node = new V2mWorkletNode(this._ctx, this._processorName, (data) => {
        this._handleProcessorMessage(data);
        if (data.message === 'wasmReady') resolve();
        if (data.message === 'probeDurationResult') {
          if (node._onProbeResult) node._onProbeResult(data.reqId, data.ms);
        }
      });

      this._node = node;

      /* gain node for volume control + optional analyser routing */
      this._gainNode = this._ctx.createGain();
      this._gainNode.gain.value = 0.8;
      node.connect(this._gainNode);
      this._gainNode.connect(this._ctx.destination);

      /* ask processor to confirm WASM readiness */
      node.port.postMessage({ message: 'getWasmReadyConfirmation' });

      // safety timeout — if WASM never fires wasmReady
      setTimeout(() => reject(new Error('V2M WASM init timeout')), 15000);
    });

    this._ready = true;
  }

  /* ── load an ArrayBuffer and start playback ── */
  async loadAndPlay(arrayBuffer, filename) {
    if (!this._ready) {
      await this.init();
    }

    // Resume context if needed (autoplay policy)
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    // Teardown any previous song
    if (this._playing) {
      try { this._node.teardown(); } catch(e) {}
      this._playing = false;
    }

    const data = new Uint8Array(arrayBuffer);
    const sampleRate = this._ctx.sampleRate;

    const loadRet = this._node.loadMusicData(sampleRate, '', filename, data);
    if (loadRet !== 0) {
      const msg = 'V2M load error (' + loadRet + ')';
      if (this.onError) this.onError(msg);
      throw new Error(msg);
    }

    const evalRet = this._node.evalTrackOptions();
    if (evalRet !== 0) {
      const msg = 'V2M evalTrackOptions error (' + evalRet + ')';
      if (this.onError) this.onError(msg);
      throw new Error(msg);
    }

    // Allocate SharedArrayBuffer scope buffers for each voice trace stream.
    // MUST happen after evalTrackOptions (which calls emu_set_subsong and
    // finalises the voice count), and before play() starts process() callbacks.
    this._allocScopeBuffers();

    // Duration will be provided by 'songEnded' message (measured in real-time).
    // Reset to 0 now — player.js will update it when the track finishes.
    this._duration = 0;

    this._node.play();
    this._playing = true;
  }

  /* Allocate double-buffered SharedArrayBuffers for voice trace streams.
     Called after evalTrackOptions so the voice count is finalised.
     Matches _allocScopeBuffers() in worker_backend.js (Wothke). */
  _allocScopeBuffers() {
    const n = this._node.getNumberTraceStreams();
    let scopeBuffers;
    if (n > 0) {
      const bufs1 = [];
      const bufs2 = [];
      for (let i = 0; i < n; i++) {
        bufs1.push(new SharedArrayBuffer(4 * 128));
        bufs2.push(new SharedArrayBuffer(4 * 128));
      }
      scopeBuffers = [bufs1, bufs2];
    } else {
      scopeBuffers = [[], []];
    }
    this._node.setSharedScopeBuffers(scopeBuffers);
  }

  stop() {
    if (!this._node || !this._playing) return;
    this._playing = false;  // set BEFORE teardown to block any in-flight songEnded
    try { this._node.teardown(); } catch(e) {}
  }

  pause() {
    if (!this._node || !this._playing) return;
    this._node.pause();
  }

  resume() {
    if (!this._node) return;
    if (this._ctx.state === 'suspended') this._ctx.resume();
    this._node.play();
  }

  setVolume(v) {
    if (this._gainNode) this._gainNode.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Connect an AnalyserNode into the signal path for the visualizer.
   * Must be called after init().
   */
  connectAnalyser(analyser) {
    if (!this._gainNode) return;
    try { this._gainNode.disconnect(); } catch(e) {}
    this._gainNode.connect(analyser);
    analyser.connect(this._ctx.destination);
  }

  get isPlaying()  { return this._playing;  }
  get duration()   { return this._duration; }

  /** Probe duration of a V2M file without playback. Returns seconds (0 = unknown).
   *  Decoding runs chunked on the AudioWorklet thread — no UI freeze, no _syncCall. */
  async probeDuration(arrayBuffer, filename) {
    if (!this._ready || !this._node) return 0;
    if (this._playing) return 0;
    return new Promise((resolve) => {
      const reqId = ++this._probeReqId;
      // Timeout safety: resolve with 0 if no reply within 30s
      const timer = setTimeout(() => {
        delete this._probeCallbacks[reqId];
        resolve(0);
      }, 30000);
      this._probeCallbacks[reqId] = (ms) => {
        clearTimeout(timer);
        resolve(ms > 0 ? ms / 1000 : 0);
      };
      // Wire the node's result router to our callback map
      this._node._onProbeResult = (id, ms) => {
        const cb = this._probeCallbacks[id];
        if (cb) { delete this._probeCallbacks[id]; cb(ms); }
      };
      const data = new Uint8Array(arrayBuffer);
      this._node.requestProbeDuration(filename, data, this._ctx.sampleRate, reqId);
    });
  }

  /** Instantly mute the gain node (called before switching to another engine). */
  silenceGain() {
    if (!this._gainNode) return;
    const ctx = this._ctx;
    this._gainNode.gain.cancelScheduledValues(ctx.currentTime);
    this._gainNode.gain.setValueAtTime(0, ctx.currentTime);
  }

  /** Restore gain to a given volume level (0-1). */
  restoreGain(vol) {
    if (!this._gainNode) return;
    const ctx = this._ctx;
    this._gainNode.gain.cancelScheduledValues(ctx.currentTime);
    this._gainNode.gain.setValueAtTime(vol, ctx.currentTime);
  }

  /* ── internal ── */
  _handleProcessorMessage(data) {
    switch (data.message) {
      case 'wasmReady':
        // handled in init() promise
        break;
      case 'songEnded':
        // Guard: ignore songEnded if we already stopped/tore down
        // (the processor's silence detector can fire AFTER teardown
        //  because teardown did not reset paused/ready in the original code)
        if (!this._playing) break;
        this._playing = false;
        if (data.duration > 0) this._duration = data.duration;
        if (this.onEnded) this.onEnded();
        break;
      case 'audioRendered':
        // scope data — not used in DEMOPLAYER
        break;
      default:
        break;
    }
  }
}
