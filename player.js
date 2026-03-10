import { ChiptuneJsPlayer } from './lib/chiptune3.js';
import { V2mEngine }        from './lib/v2m-worklet.js';
import { MidiEngine }       from './lib/midi-engine.js';

/* ═══════════════════════════════════════════════
   DEMOPLAYER v4.0 — Keygen Edition
   ═══════════════════════════════════════════════ */

/* ── State ── */
let player, audioCtx, analyser;
let v2mEngine = null, v2mReady = false;   // V2M engine (farbrausch WorkerBackend)
let midiEngine = null, midiReady = false; // MIDI engine (MidiPlayerJS + GM synth)
let pl=[], ci=-1, playing=false, paused=false, looping=false, shuffling=false, init=false;
let shuffleHistory=[];
let scanner=null, scannerReady=false;

/* ── DOM ── */
const g=id=>document.getElementById(id);
const smsg=g('smsg'), plbox=g('plbox'), emp=g('empty');
const nTtl=g('now-ttl'), nExt=g('now-ext');
const bPlay=g('bPlay'), bLoop=g('bLoop'), bShuf=g('bShuf');
const pfill=g('pfill'), tC=g('tC'), tT=g('tT');
const mT=g('mT'), mC=g('mC'), mO=g('mO');
const plInfo=g('plInfo');
const vc=g('vizCanvas'), vx=vc.getContext('2d');
const fIn=g('fIn'), fDir=g('fDir');

/* ── Scrolltext ── */
{
  const el=g('scrolltext'), wr=g('scroll-wrap');
  let x=wr.offsetWidth;
  (function tick(){
    x-=0.5;
    if(x<-el.offsetWidth) x=wr.offsetWidth;
    el.style.transform='translateX('+x+'px)';
    requestAnimationFrame(tick);
  })();
}

/* ══════════════════════════════════════════════════
   ENGINE INIT
   ══════════════════════════════════════════════════ */
function boot(){
  try{
    player=new ChiptuneJsPlayer();
    stat('LOADING LIBOPENMPT...','ld');

    player.onInitialized(()=>{
      init=true;
      audioCtx=player.context||player.ctx||null;

      // Analyser for visualizer
      if(audioCtx){
        analyser=audioCtx.createAnalyser();
        analyser.fftSize=256;
        analyser.smoothingTimeConstant=0.75;
        try{player.gain.disconnect()}catch(e){}
        player.gain.connect(analyser);
        analyser.connect(audioCtx.destination);
      }

      // Events (assigned AFTER init)
      player.onEnded=()=>{
        if(!playing) return;
        _triggerAutoNext();
      };
      player.onError=e=>stat('ERROR: '+e,'er');

      stat('READY \u2014 DROP YOUR MODULES','ok');
      if(analyser) startViz();

      // V2M engine — initialise in background, pass the shared AudioContext
      _bootV2m(audioCtx);

      // MIDI engine — initialise in background, share AudioContext
      _bootMidi(audioCtx);
    });

    // Scanner: muted second player for pre-reading duration
    scanner=new ChiptuneJsPlayer();
    scanner.onInitialized(()=>{
      scannerReady=true;
      if(scanner.gain) scanner.gain.gain.value=0;
    });

  }catch(e){ stat('AUDIO INIT FAILED','er'); }
}

/* ══════════════════════════════════════════════════
   V2M ENGINE BOOT  (lazy, background)
   ══════════════════════════════════════════════════ */
async function _bootV2m(ctx){
  try{
    v2mEngine = new V2mEngine();
    await v2mEngine.init(ctx);   // share ChiptuneJsPlayer's AudioContext

    // Wire onEnded
    v2mEngine.onEnded = ()=>{
      if(!playing) return;
      v2mEngine._activeIdx = -1;
      _triggerAutoNext();
    };
    v2mEngine.onError = (msg)=>stat('V2M ERROR: '+msg,'er');

    // If an analyser is already set up, connect the V2M gain into it
    if(analyser) v2mEngine.connectAnalyser(analyser);

    v2mReady = true;
    console.log('[V2M] engine ready');

    _scanV2mDurations();

    // If a V2M track was queued while engine was loading, play it now
    if(typeof _pendingV2mPlay === 'function'){
      _pendingV2mPlay();
      _pendingV2mPlay = null;
    }
  }catch(e){
    console.warn('[V2M] engine init failed:', e);
    v2mEngine = null;
  }
}

let _pendingV2mPlay = null;

/* ══════════════════════════════════════════════════
   MIDI ENGINE BOOT  (lazy, background)
   ══════════════════════════════════════════════════ */
let _pendingMidiPlay = null;

async function _bootMidi(ctx){
  try{
    midiEngine = new MidiEngine();
    await midiEngine.init(ctx);

    midiEngine.onEnded = ()=>{
      if(!playing) return;
      _triggerAutoNext();
    };
    midiEngine.onError = (msg)=>stat('MIDI ERROR: '+msg,'er');

    if(analyser) midiEngine.connectAnalyser(analyser);

    midiReady = true;
    console.log('[MIDI] engine ready');

    if(typeof _pendingMidiPlay === 'function'){
      _pendingMidiPlay();
      _pendingMidiPlay = null;
    }
  }catch(e){
    console.warn('[MIDI] engine init failed:', e);
    midiEngine = null;
  }
}

let _v2mScanBusy = false;
async function _scanV2mDurations() {
  return; // V2M duration calculation disabled (no reliable method)
}

let tmr=null, tStart=0, tPaused=0;
let _autoNextPending = false; // guard against double-fire

function startTimer(){
  stopTimer();
  tStart=audioCtx?audioCtx.currentTime:0;
  tPaused=0;
  _autoNextPending = false;
  tmr=setInterval(tickTimer,200);
}
function stopTimer(){ if(tmr){clearInterval(tmr);tmr=null} }

function tickTimer(){
  if(!playing || _autoNextPending) return;

  const isV2m = ci>=0 && pl[ci] && pl[ci].v2m;
  const isMidi = ci>=0 && pl[ci] && pl[ci].midi;

  if(isV2m){
    pfill.style.width = '0%';
    tC.textContent = '0:00';
    tT.textContent = '--:--';
    mO.textContent = '\u2014';
    return;
  }

  if(isMidi){
    if(!midiEngine) return;
    const dur = midiEngine.duration || 0;
    const pct = midiEngine.progress;   // 0..1, from 'playing' event tick
    const cur = midiEngine.currentTime; // pct × duration

    pfill.style.width = (pct * 100) + '%';
    tC.textContent = fmt(cur);
    tT.textContent = dur > 0 ? fmt(dur) : '--:--';
    mO.textContent = Math.floor(pct * 100) + '%';
    return;
  }

  if(!player) return;
  const dur=player.duration||0;
  if(dur<=0) return;

  if(ci>=0&&pl[ci]&&!pl[ci].dur){
    pl[ci].dur=dur;
    updateDurCell(ci);
    updatePlInfo();
  }

  let elapsed=paused? tPaused : (audioCtx?audioCtx.currentTime:0)-tStart+tPaused;
  if(elapsed<0) elapsed=0;
  if(elapsed>dur) elapsed=dur;
  const pct=elapsed/dur;

  pfill.style.width=(pct*100)+'%';
  tC.textContent=fmt(elapsed);
  tT.textContent=fmt(dur);
  mO.textContent=Math.floor(pct*100)+'%';

  if(elapsed>=dur-0.5){
    _triggerAutoNext();
  }
}

function _triggerAutoNext(){
  if(_autoNextPending) return;
  _autoNextPending = true;
  playing=false; paused=false; bPlay.textContent='\u25B6';
  stopTimer();
  autoNext();
}

/* ══════════════════════════════════════════════════
   ENGINE MANAGEMENT — stop & audio graph
   ══════════════════════════════════════════════════ */
function _stopAllEngines(){
  if(player){
    if(player.gain && audioCtx){
      try{
        player.gain.gain.cancelScheduledValues(audioCtx.currentTime);
        player.gain.gain.setValueAtTime(0, audioCtx.currentTime);
      }catch(e){}
    }
    try{ player.stop(); }catch(e){}
  }
  if(v2mEngine){
    try{ v2mEngine.stop(); }catch(e){}
    try{ v2mEngine.silenceGain(); }catch(e){}
  }
  if(midiEngine){
    try{ midiEngine.stop(); }catch(e){}
    try{ midiEngine.silenceGain(); }catch(e){}
  }
}

function _rewireAudio(item){
  if(!analyser || !audioCtx) return;

  try{ analyser.disconnect(); }catch(e){}

  if(player && player.gain) try{ player.gain.disconnect(); }catch(e){}
  if(v2mEngine && v2mEngine._gainNode) try{ v2mEngine._gainNode.disconnect(); }catch(e){}
  if(midiEngine && midiEngine._gainNode) try{ midiEngine._gainNode.disconnect(); }catch(e){}

  if(item.v2m){
  } else if(item.midi){
  } else {
    player.gain.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
}

/* ══════════════════════════════════════════════════
   PLAYBACK (WITH LAZY LOADING)
   ══════════════════════════════════════════════════ */
async function doPlay(i){
  if(i<0||i>=pl.length||!init) return;
  if(audioCtx&&audioCtx.state==='suspended') await audioCtx.resume();

  // ── Hard stop ALL engines + clean audio graph ──────────────────────
  _stopAllEngines();
  playing = false;

  ci=i;
  const it=pl[i];

  // Reconnect audio graph for the engine that's about to play
  _rewireAudio(it);

  stat('LOADING: '+it.name,'ld');
  nTtl.textContent=it.name;
  nExt.textContent=it.ext.toUpperCase();

  /* ── Lazy loading: fetch audio on demand to save RAM ── */
  let trackBuf = it.buf; // Already in memory if loaded via drag & drop
  
  if (!trackBuf && it.path) {
    stat('FETCHING AUDIO...', 'ld');
    try {
      const res = await fetch(it.path);
      if (!res.ok) throw new Error('File not found');
      trackBuf = await res.arrayBuffer(); // Downloaded just-in-time for playback
    } catch(e) {
      stat('DOWNLOAD FAILED', 'er');
      playing = false;
      return;
    }
  }
  
  if (!trackBuf) {
    stat('NO AUDIO DATA', 'er');
    return;
  }
  /* ──────────────────────────────── */

  /* ── V2M path ── */
  if(it.v2m){
    g('seng').textContent='v2m engine';

    const _run = async ()=>{
      const _v2mIdx = ci; 
      try{
        if(analyser) v2mEngine.connectAnalyser(analyser);
        v2mEngine.restoreGain(g('vol').value/100);  
        v2mEngine._activeIdx = _v2mIdx; 
        
        // Pass the fetched buffer to the engine
        await v2mEngine.loadAndPlay(trackBuf.slice(0), it.name+'.v2m');
        
        playing=true; paused=false;
        bPlay.textContent='\u23F8';
        stat('PLAYING: '+it.name+' [V2M]','ok');
        mT.textContent='V2M (farbrausch)';
        mC.textContent='\u2014';
        tT.textContent = '--:--';
        tC.textContent = '0:00';
        pfill.style.width = '0%';
        startTimer();
        highlightActive();
      }catch(err){
        stat('V2M ERROR: '+err.message,'er');
        playing=false;
      }
    };

    if(v2mReady && v2mEngine){
      await _run();
    } else {
      stat('V2M ENGINE LOADING...','ld');
      _pendingV2mPlay = _run;
    }
    return;
  }

  /* ── MIDI path ── */
  if(it.midi){
    g('seng').textContent='midi engine';

    // Parse channels on-the-fly if not already known
    if(!it.midiChannels && trackBuf && typeof MidiPlayer !== 'undefined'){
      try{
        const tmp = new MidiPlayer.Player();
        tmp.loadArrayBuffer(trackBuf.slice(0));
        const chSet = new Set();
        tmp.tracks.forEach(trk => {
          if(trk.events) trk.events.forEach(ev => {
            if(ev.channel && ev.channel > 0) chSet.add(ev.channel);
          });
        });
        if(chSet.size > 0) it.midiChannels = chSet.size;
        tmp.stop();
      }catch(e){}
    }

    const _runMidi = async ()=>{
      try{
        if(analyser) midiEngine.connectAnalyser(analyser);
        midiEngine.restoreGain(g('vol').value/100);
        
        // Pass the fetched buffer to the engine
        await midiEngine.loadAndPlay(trackBuf.slice(0), it.name+'.mid');
        
        playing=true; paused=false;
        bPlay.textContent='\u23F8';
        stat('PLAYING: '+it.name+' [MIDI]','ok');
        mT.textContent='MIDI (Standard MIDI File)';
        mC.textContent= it.midiChannels ? it.midiChannels : '\u2014';
        const dur = midiEngine.duration || 0;
        if(dur > 0){
          tT.textContent = fmt(dur);
          pl[ci].dur = dur;
          updateDurCell(ci);
          updatePlInfo();
        } else {
          tT.textContent = '--:--';
        }
        tC.textContent = '0:00';
        pfill.style.width = '0%';
        startTimer();
        highlightActive();
      }catch(err){
        stat('MIDI ERROR: '+err.message,'er');
        playing=false;
      }
    };

    if(midiReady && midiEngine){
      await _runMidi();
    } else {
      stat('MIDI ENGINE LOADING...','ld');
      _pendingMidiPlay = _runMidi;
    }
    return;
  }

  /* ── libopenmpt path ── */
  g('seng').textContent='libopenmpt engine';

  if(player.gain){
    player.gain.gain.cancelScheduledValues(audioCtx.currentTime);
    player.gain.gain.setValueAtTime(g('vol').value/100, audioCtx.currentTime);
  }

  try{
    // Pass the fetched buffer to the engine
    player.play(trackBuf);
    playing=true; paused=false;
    bPlay.textContent='\u23F8';
    stat('PLAYING: '+it.name,'ok');
    if(player.gain) player.gain.gain.value=g('vol').value/100;
    startTimer();

    setTimeout(()=>{
      if(!player) return;
      const d=player.duration;
      if(d&&ci>=0&&pl[ci]){
        pl[ci].dur=d;
        updateDurCell(ci);
        tT.textContent=fmt(d);
        updatePlInfo();
      }
      if(player.meta){
        displayMeta(player.meta);
        if(ci>=0&&pl[ci]) pl[ci].meta={...player.meta};
      }
    },500);

    if(it.meta) displayMeta(it.meta);
    highlightActive();
  }catch(e){ stat('ERROR: '+e.message,'er'); }
}

function doToggle(){
  if(!init){
    if(!player) boot();
    else stat('ENGINE LOADING...','ld');
    return;
  }
  if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();

  if(!playing&&pl.length){
    doPlay(ci>=0?ci:0);
    return;
  }
  if(!playing) return;

  if(ci>=0&&pl[ci]&&pl[ci].v2m){
    if(v2mEngine){
      if(!paused){
        v2mEngine.pause();
        tPaused=(audioCtx?audioCtx.currentTime:0)-tStart+tPaused;
        paused=true;
      } else {
        v2mEngine.resume();
        tStart=audioCtx?audioCtx.currentTime:0;
        paused=false;
      }
    }
  } else if(ci>=0&&pl[ci]&&pl[ci].midi){
    if(midiEngine){
      if(!paused){
        midiEngine.pause();
        paused=true;
      } else {
        midiEngine.resume();
        paused=false;
      }
    }
  } else {
    player.togglePause();
    if(!paused){
      tPaused=(audioCtx?audioCtx.currentTime:0)-tStart+tPaused;
      paused=true;
    } else {
      tStart=audioCtx?audioCtx.currentTime:0;
      paused=false;
    }
  }
  bPlay.textContent=paused?'\u25B6':'\u23F8';
  stat(paused?'PAUSED':'PLAYING: '+pl[ci].name,'ok');
}

function doStop(){
  if(!player&&!v2mEngine&&!midiEngine) return;
  if(!playing) return;
  _stopAllEngines();
  playing=false; paused=false;
  bPlay.textContent='\u25B6';
  pfill.style.width='0%'; tC.textContent='0:00';
  stopTimer();
  highlightActive();
  stat('STOPPED','ok');
  g('seng').textContent='libopenmpt engine';
}

function doSeek(e){
  if(!playing) return;
  const rect=e.currentTarget.getBoundingClientRect();
  const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));

  if(ci>=0 && pl[ci] && pl[ci].midi && midiEngine){
    midiEngine.seek(pct);
    const dur = midiEngine.duration || 0;
    pfill.style.width=(pct*100)+'%';
    tC.textContent=fmt(pct*dur);
    return;
  }

  if(ci>=0 && pl[ci] && pl[ci].v2m) return;

  if(!player) return;
  const dur=player.duration||0;
  if(dur<=0) return;

  try{
    if(player.seek) player.seek(pct * dur);
    else if(player.setPos) player.setPos(pct * dur);
  }catch(ex){}

  tPaused=pct*dur;
  tStart=audioCtx?audioCtx.currentTime:0;

  pfill.style.width=(pct*100)+'%';
  tC.textContent=fmt(pct*dur);
}

/* ══════════════════════════════════════════════════
   AUTO-NEXT / SHUFFLE
   ══════════════════════════════════════════════════ */
function autoNext(){
  if(shuffling){
    const nx=pickShuffle();
    if(nx>=0){ setTimeout(()=>doPlay(nx),300); }
    else {
      shuffling=false; bShuf.classList.remove('toggled'); shuffleHistory=[];
      stat('SHUFFLE COMPLETE','ok');
    }
  } else if(ci<pl.length-1){
    setTimeout(()=>doPlay(ci+1),300);
  } else if(looping&&pl.length){
    setTimeout(()=>doPlay(0),300);
  } else {
    stat('PLAYBACK ENDED','ok');
  }
}
function doNext(){
  if(!pl.length) return;
  if(shuffling){
    const nx=pickShuffle();
    if(nx>=0) doPlay(nx);
    else { shuffling=false; bShuf.classList.remove('toggled'); shuffleHistory=[]; stat('SHUFFLE COMPLETE','ok'); }
    return;
  }
  doPlay((ci+1)%pl.length);
}
function doPrev(){
  if(!pl.length) return;
  if(shuffling&&shuffleHistory.length>=2){ shuffleHistory.pop(); doPlay(shuffleHistory[shuffleHistory.length-1]); return; }
  let p=ci-1; if(p<0)p=pl.length-1; doPlay(p);
}
function doLoop(){
  looping=!looping;
  bLoop.classList.toggle('toggled',looping);
}
function doShuffle(){
  shuffling=!shuffling;
  bShuf.classList.toggle('toggled',shuffling);
  if(shuffling){
    if(looping){
      looping=false;
      bLoop.classList.remove('toggled');
    }
    shuffleHistory=ci>=0?[ci]:[];
    stat('SHUFFLE ON \u2014 NO REPEAT','ok');
  } else {
    shuffleHistory=[];
    stat('SHUFFLE OFF','ok');
  }
}
function pickShuffle(){
  const played=new Set(shuffleHistory), avail=[];
  for(let i=0;i<pl.length;i++){
    if(played.has(i)) continue;
    if(pl[i].v2m && !v2mReady) continue;  
    if(pl[i].midi && !midiReady) continue; 
    avail.push(i);
  }
  if(!avail.length) return -1;
  const pick=avail[Math.floor(Math.random()*avail.length)];
  shuffleHistory.push(pick);
  return pick;
}

/* ══════════════════════════════════════════════════
   METADATA DISPLAY
   ══════════════════════════════════════════════════ */
function displayMeta(m){
  if(!m) return;
  mT.textContent = m.type_long || m.type || '\u2014';
  mC.textContent = m.totalPatterns || '\u2014';
  if(m.title && m.title.trim() && ci>=0) nTtl.textContent = m.title.trim();
}

function rstMeta(){
  mT.textContent = mC.textContent = mO.textContent = '\u2014';
  pfill.style.width = '0%';
  tC.textContent = tT.textContent = '0:00';
}

/* ══════════════════════════════════════════════════
   PLAYLIST UI
   ══════════════════════════════════════════════════ */
function highlightActive(){
  const items=plbox.querySelectorAll('.pi');
  items.forEach((el,i)=>{
    const act=i===ci;
    el.classList.toggle('act',act);
    const num=el.querySelector('.pno');
    if(num) num.textContent=act&&playing?'\u25B6':String(i+1).padStart(2,'0');
  });
  const a=plbox.querySelector('.pi.act');
  if(a) a.scrollIntoView({block:'nearest',behavior:'smooth'});
  updatePlInfo();
}

function updateDurCell(idx){
  const items=plbox.querySelectorAll('.pi');
  if(items[idx]){
    const el=items[idx].querySelector('.pdur');
    if(el && pl[idx].dur && !pl[idx].v2m) el.textContent=fmt(pl[idx].dur);
  }
}

function updatePlInfo(){
  if(!pl.length){ plInfo.textContent=''; return; }
  const trk=ci>=0?(ci+1)+'/'+pl.length:'0/'+pl.length;
  let tot=0, n=0;
  for(const it of pl) if(!it.v2m && it.dur>0){tot+=it.dur;n++}
  let ds='';
  if(n>0){
    const h=Math.floor(tot/3600), m=Math.floor((tot%3600)/60), s=Math.floor(tot%60);
    ds=h>0?' \u2014 '+h+'h'+String(m).padStart(2,'0')+'m'
          :' \u2014 '+m+'m'+String(s).padStart(2,'0')+'s';
    if(n<pl.length) ds+=' ('+n+'/'+pl.length+')';
  }
  plInfo.textContent='TRACK '+trk+ds;
}

function renderPL(){
  g('plCnt').textContent=pl.length?'['+pl.length+']':'';
  if(!pl.length){ plbox.style.display='none'; emp.style.display='flex'; updatePlInfo(); return; }
  plbox.style.display='block'; emp.style.display='none';
  plbox.innerHTML='';
  pl.forEach((it,i)=>{
    const d=document.createElement('div');
    d.className='pi'+(i===ci?' act':'');
    const ds=(!it.v2m && it.dur)?fmt(it.dur):'--:--';
    d.innerHTML='<span class="pno">'+(i===ci&&playing?'\u25B6':String(i+1).padStart(2,'0'))
      +'</span><span class="pn">'+esc(it.name)
      +'</span><span class="pe">'+it.ext
      +'</span><span class="pdur">'+ds
      +'</span><span class="px">\u2715</span>';
    d.addEventListener('click',()=>{
      if(!init){stat('ENGINE LOADING...','ld');return}
      doPlay(i);
    });
    d.querySelector('.px').addEventListener('click',e=>{
      e.stopPropagation();
      const was=i===ci;
      pl.splice(i,1);
      if(was){doStop();ci=-1;rstMeta()}
      else if(i<ci) ci--;
      renderPL();
    });
    plbox.appendChild(d);
  });
  updatePlInfo();
}

/* ══════════════════════════════════════════════════
   SCANNER — pre-read duration (fast, no audio)
   ══════════════════════════════════════════════════ */
let scanQ=[], scanBusy=false;

function enqueueScan(item,idx){
  scanQ.push({item,idx});
  if(!scanBusy) nextScan();
}
function nextScan(){
  if(!scanQ.length||!scannerReady){scanBusy=false;return}
  scanBusy=true;
  const {item,idx}=scanQ.shift();
  
  // Only prescan files already in memory (e.g. drag & drop)
  if(!item.buf) { 
    nextScan(); 
    return; 
  }

  try{
    scanner.play(item.buf);
    setTimeout(()=>{
      try{
        const dur=scanner.duration;
        if(dur>0){ item.dur=dur; updateDurCell(idx); updatePlInfo(); }
        if(scanner.meta) item.meta={...scanner.meta};
      }catch(e){}
      try{scanner.stop()}catch(e){}
      nextScan();
    },100);
  }catch(e){ nextScan(); }
}

/* ══════════════════════════════════════════════════
   MIDI DURATION PRE-SCAN
   ══════════════════════════════════════════════════ */
function _scanMidiDurations(startIdx){
  if(typeof MidiPlayer === 'undefined'){
    const _retry = ()=> _scanMidiDurations(startIdx);
    if(!midiReady){
      const _origPending = _pendingMidiPlay;
      _pendingMidiPlay = ()=>{ if(_origPending) _origPending(); _retry(); };
    }
    return;
  }
  for(let j=startIdx; j<pl.length; j++){
    if(!pl[j].midi || !pl[j].buf) continue; // Skip if no buffer (lazy load mode)
    try{
      const tmp = new MidiPlayer.Player();
      tmp.loadArrayBuffer(pl[j].buf.slice(0));
      const dur = tmp.getSongTime() || 0;
      if(dur > 0){
        pl[j].dur = dur;
        updateDurCell(j);
      }
      const chSet = new Set();
      tmp.tracks.forEach(trk => {
        if(trk.events) trk.events.forEach(ev => {
          if(ev.channel && ev.channel > 0) chSet.add(ev.channel);
        });
      });
      if(chSet.size > 0){
        pl[j].midiChannels = chSet.size;
      }
      tmp.stop();
    }catch(e){ console.warn('[MIDI scan] failed for', pl[j].name, e); }
  }
  updatePlInfo();
}

/* ══════════════════════════════════════════════════
   FILE HANDLING
   ══════════════════════════════════════════════════ */
const EXT=new Set(['mod','xm','it','s3m','mptm','med','oct','okt','stm','669','far','amf','ams','dbm','dmf','dsm','umx','mt2','psm','j2b','gdm','imf','ptm','sfx','wow','v2m','mid','midi']);
const ext=n=>n.split('.').pop().toLowerCase();

function addFiles(fs){
  const v=Array.from(fs).filter(f=>EXT.has(ext(f.name)));
  if(!v.length){stat('NO SUPPORTED FILES','er');return}
  stat('LOADING '+v.length+' FILE(S)...','ld');
  let ld=0;
  const start=pl.length;
  v.forEach(f=>{
    const r=new FileReader();
    r.onload=ev=>{
      const e=ext(f.name);
      const rel=f.webkitRelativePath||'';
      const name=rel?rel.replace(/\.[^.]+$/,''):f.name.replace(/\.[^.]+$/,'');
      const isMidi = (e==='mid'||e==='midi');
      pl.push({name,ext:e,buf:ev.target.result,v2m:e==='v2m',midi:isMidi,dur:0,meta:null,path:null});
      ld++;
      if(ld===v.length){
        _scanMidiDurations(start);
        renderPL();
        stat(ld+' FILE(S) ADDED \u2014 '+pl.length+' TOTAL','ok');
        for(let j=start;j<pl.length;j++) if(!pl[j].v2m && !pl[j].midi) enqueueScan(pl[j],j);
        if (v2mReady) _scanV2mDurations();
      }
    };
    r.readAsArrayBuffer(f);
  });
}

function doClear(){
  doStop(); pl=[]; ci=-1; shuffleHistory=[]; scanQ=[]; scanBusy=false;
  renderPL(); rstMeta();
  nTtl.textContent='\u2014 no file loaded \u2014'; nExt.textContent='';
  updatePlInfo();
  stat('PLAYLIST CLEARED','ok');
}

/* ══════════════════════════════════════════════════
   DRAG & DROP (folder-aware)
   ══════════════════════════════════════════════════ */
const dz=g('dz'); let dc=0;
document.addEventListener('dragenter',e=>{e.preventDefault();dc++;dz.classList.add('show')});
document.addEventListener('dragleave',e=>{e.preventDefault();dc--;if(dc<=0){dc=0;dz.classList.remove('show')}});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{
  e.preventDefault();dc=0;dz.classList.remove('show');
  const items=e.dataTransfer.items;
  if(items&&items.length){
    const entries=[];
    for(let i=0;i<items.length;i++){
      const en=items[i].webkitGetAsEntry&&items[i].webkitGetAsEntry();
      if(en) entries.push(en);
    }
    if(entries.some(en=>en.isDirectory)){
      stat('SCANNING FOLDERS...','ld');
      scanEntries(entries).then(files=>{
        if(files.length) addFiles(files); else stat('NO MODULES FOUND','er');
      });
      return;
    }
  }
  if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

async function scanEntries(entries){
  const files=[];
  async function read(entry){
    if(entry.isFile){
      const f=await new Promise((r,j)=>entry.file(r,j));
      if(EXT.has(ext(f.name))) files.push(f);
    } else if(entry.isDirectory){
      const reader=entry.createReader();
      let batch;
      do{
        batch=await new Promise((r,j)=>reader.readEntries(r,j));
        for(const c of batch) await read(c);
      }while(batch.length);
    }
  }
  for(const e of entries) await read(e);
  return files;
}

/* ══════════════════════════════════════════════════
   JSON PLAYLIST LOADER (anti-cache + path resolver)
   ══════════════════════════════════════════════════ */
async function loadPlaylist(url, remoteBase) {
  if (!init) { stat('ENGINE LOADING...', 'ld'); return; }
  
  doClear();
  stat('DOWNLOADING PLAYLIST DB...', 'ld');
  
  try {
    // 1. Anti-cache: append timestamp to force fresh download
    const noCacheUrl = url + '?t=' + new Date().getTime();
    const res = await fetch(noCacheUrl);
    
    if (!res.ok) throw new Error('HTTP ' + res.status + ' (' + url + ')');
    const data = await res.json();
    
    // 2. Extract base directory from JSON path (e.g. "./playlists/Ryo/")
    const basePath = url.substring(0, url.lastIndexOf('/') + 1);
    
    pl = data.map(item => {
      const extension = (item.ext || item.filename.split('.').pop()).toLowerCase();
      
      // 3. Build file path: remote (Cloudflare R2) or local
      let fixedPath = item.path;
      if (remoteBase) {
        fixedPath = remoteBase + (fixedPath.startsWith('./') ? fixedPath.substring(2) : fixedPath);
      } else if (fixedPath.startsWith('./')) {
        fixedPath = basePath + fixedPath.substring(2);
      } else {
        fixedPath = basePath + fixedPath;
      }

      // 4. Encode special characters in filenames (#, ?, etc.)
      // Encode per path segment to preserve slashes
      fixedPath = fixedPath.split('/').map(seg => encodeURIComponent(seg).replace(/%2520/g,'%20')).join('/');
      // Restore protocol for absolute URLs (https:)
      fixedPath = fixedPath.replace(/^(https?%3A)/, m => decodeURIComponent(m));

      return {
        name: item.filename ? item.filename.replace(/\.[^.]+$/, '') : (item.title || 'unknown'),
        ext: extension,
        path: fixedPath, // Fully resolved path
        buf: null,       // No RAM consumed until playback
        v2m: extension === 'v2m',
        midi: extension === 'mid' || extension === 'midi',
        midiChannels: item.channels || 0,
        dur: item.duration || 0,
        meta: null
      };
    });
    
    renderPL();
    stat('PLAYLIST LOADED \u2014 ' + pl.length + ' TRACKS', 'ok');
    
    // Auto-play first track
    if (pl.length > 0) {
      setTimeout(() => doPlay(0), 300);
    }
    
  } catch(e) {
    stat('ERROR LOADING JSON', 'er');
    console.error("Playlist load error:", e);
    alert("Failed to load playlist.\n\nCheck the browser console (F12 > Console) for details.");
  }
}

/* ══════════════════════════════════════════════════
   REMOTE STORAGE (Cloudflare R2)
   ══════════════════════════════════════════════════ */
const R2_BASE = 'https://pub-74e1e6ec679245f6b7dc7c3b16c831aa.r2.dev/';

/* ══════════════════════════════════════════════════
   EVENT BINDINGS
   ══════════════════════════════════════════════════ */
g('bPlay').addEventListener('click',doToggle);
g('bStop').addEventListener('click',doStop);
g('bNext').addEventListener('click',doNext);
g('bPrev').addEventListener('click',doPrev);
g('bLoop').addEventListener('click',doLoop);
g('bShuf').addEventListener('click',doShuffle);
g('bAdd').addEventListener('click',()=>fIn.click());
g('bScan').addEventListener('click',()=>fDir.click());
g('bClr').addEventListener('click',doClear);
g('bRyo').addEventListener('click', () => loadPlaylist('./playlists/Ryo/Ryo.json', R2_BASE ? R2_BASE + 'Ryo/' : null));
g('bKgm').addEventListener('click', () => loadPlaylist('./playlists/KEYGENMUSiC/KEYGENMUSiC.json', R2_BASE ? R2_BASE + 'KEYGENMUSiC/' : null));

g('vol').addEventListener('input',e=>{
  const v=e.target.value/100;
  if(player&&player.gain) player.gain.gain.value=v;
  if(v2mEngine) v2mEngine.setVolume(v);
  if(midiEngine) midiEngine.setVolume(v);
});
g('pbar').addEventListener('click',doSeek);
fIn.addEventListener('change',e=>{addFiles(e.target.files);fIn.value=''});
fDir.addEventListener('change',e=>{addFiles(e.target.files);fDir.value=''});
document.addEventListener('keydown',e=>{
  if(e.code==='Space'){e.preventDefault();doToggle()}
  if(e.code==='ArrowRight') doNext();
  if(e.code==='ArrowLeft') doPrev();
});

/* ══════════════════════════════════════════════════
   VISUALIZER — keygen bars
   ══════════════════════════════════════════════════ */
function startViz(){
  function resize(){
    const r=vc.parentElement.getBoundingClientRect();
    vc.width=Math.floor(r.width);
    vc.height=Math.floor(r.height);
  }
  resize();
  window.addEventListener('resize',resize);

  const bins=analyser.frequencyBinCount;
  const fd=new Uint8Array(bins);
  const peaks=new Float32Array(64).fill(0);
  const pvel=new Float32Array(64).fill(0);

  function draw(){
    requestAnimationFrame(draw);
    analyser.getByteFrequencyData(fd);
    const W=vc.width, H=vc.height;

    vx.fillStyle='rgba(0,0,0,0.4)';
    vx.fillRect(0,0,W,H);

    vx.strokeStyle='rgba(57,255,20,0.03)'; vx.lineWidth=1;
    for(let y=0;y<H;y+=12){vx.beginPath();vx.moveTo(0,y);vx.lineTo(W,y);vx.stroke()}
    for(let x=0;x<W;x+=20){vx.beginPath();vx.moveTo(x,0);vx.lineTo(x,H);vx.stroke()}

    const bc=48, gap=2, bw=Math.max(3,(W-gap*bc)/bc);
    const step=Math.max(1,Math.floor(bins/bc));

    for(let i=0;i<bc;i++){
      let sum=0;
      for(let j=0;j<step;j++) sum+=fd[i*step+j]||0;
      const val=(sum/step)/255;
      
      const maxBarHeight = H - 20; 
      const bh = val * maxBarHeight;
      const x=i*(bw+gap)+gap;

      const gr=vx.createLinearGradient(0,H,0,H-bh);
      gr.addColorStop(0,'rgba(57,255,20,0.95)');
      gr.addColorStop(0.45,'rgba(0,255,204,0.9)');
      gr.addColorStop(0.8,'rgba(255,204,0,0.9)');
      gr.addColorStop(1,'rgba(255,0,170,0.95)');
      vx.fillStyle=gr;
      vx.fillRect(x,H-bh,bw,bh);

      for(let sy=H-bh;sy<H;sy+=5){
        vx.fillStyle='rgba(0,0,0,0.15)';
        vx.fillRect(x,sy+4,bw,1);
      }

      if(val>peaks[i]){peaks[i]=val;pvel[i]=0}
      else{pvel[i]+=0.005;peaks[i]-=pvel[i]}
      if(peaks[i]<0) peaks[i]=0;
      
      const py=H-peaks[i]*maxBarHeight;
      vx.fillStyle='rgba(255,255,255,0.9)';
      vx.fillRect(x,py-2,bw,2);

      vx.fillStyle='rgba(57,255,20,'+val*0.06+')';
      vx.fillRect(x-1,H-bh-2,bw+2,bh+4);
    }
  }
  draw();
}

/* ══════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════ */
function stat(m,t){smsg.textContent=m;smsg.className=t||''}
function fmt(s){
  if(!s||isNaN(s)) return '0:00';
  const m=Math.floor(s/60), sec=Math.floor(s%60);
  return m+':'+String(sec).padStart(2,'0');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

/* ══════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════ */
boot();