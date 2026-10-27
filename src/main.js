import './style.css';
import { decodeFile, fetchFile, MAX_BYTES } from './load.js';
import { Renderer, prepareImages } from './renderer.js';

const $ = id => document.getElementById(id);
const state = { renderer: null, movie: null, frame: 0, playing: false, loop: true, speed: 1, start: 0, tick: 0, controller: null };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const prettyBytes = bytes => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}

function draw() {
  if (!state.renderer) return;
  try { state.renderer.draw(state.frame); }
  catch (error) { pause(); showError(error); }
  $('timeline').value = state.frame;
  $('timeline').style.setProperty('--progress', `${state.frame / Math.max(1, state.movie.frames - 1) * 100}%`);
  $('current-time').textContent = `${(state.frame / state.movie.fps).toFixed(2)}s`;
  $('frame-label').textContent = `FRAME ${String(state.frame + 1).padStart(3, '0')} / ${String(state.movie.frames).padStart(3, '0')}`;
  $('timeline').setAttribute('aria-valuetext', `Frame ${state.frame + 1} of ${state.movie.frames}`);
}

function resize() {
  if (!state.movie) return;
  const container = $('canvas-space');
  const selected = $('zoom').value;
  const scale = selected === 'fit' ? Math.min(container.clientWidth / state.movie.width, container.clientHeight / state.movie.height) : Number(selected);
  $('canvas').style.width = `${state.movie.width * scale}px`;
  $('canvas').style.height = `${state.movie.height * scale}px`;
  // Auto margins keep oversized canvases scrollable from their top-left corner.
  $('canvas').style.margin = 'auto';
}

function pause() {
  state.playing = false;
  cancelAnimationFrame(state.tick);
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play');
}

function play() {
  if (!state.movie || state.controller || state.movie.frames <= 1) return;
  if (state.frame === state.movie.frames - 1) state.frame = 0;
  state.playing = true;
  state.start = performance.now() - state.frame / state.movie.fps / state.speed * 1000;
  $('play').textContent = 'Ⅱ';
  $('play').setAttribute('aria-label', 'Pause');
  const tick = now => {
    if (!state.playing) return;
    let frame = Math.floor((now - state.start) * state.movie.fps * state.speed / 1000);
    if (frame >= state.movie.frames && !state.loop) { state.frame = state.movie.frames - 1; pause(); draw(); return; }
    frame %= state.movie.frames;
    if (frame !== state.frame) { state.frame = frame; draw(); }
    if (state.playing) state.tick = requestAnimationFrame(tick);
  };
  draw();
  state.tick = requestAnimationFrame(tick);
}

function step(delta) {
  if (!state.movie || state.controller) return;
  pause();
  state.frame = Math.max(0, Math.min(state.movie.frames - 1, state.frame + delta));
  draw();
}

async function load(source, demo = false) {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const signal = controller.signal;
  const networkTimeout = setTimeout(() => controller.abort(new Error('Loading timed out. Please try again.')), 45_000);
  pause();
  $('error').hidden = true;
  $('error').textContent = '';
  $('loading').hidden = false;
  $('play').disabled = $('timeline').disabled = true;
  $('loading-text').textContent = typeof source === 'string' ? 'Fetching animation…' : 'Decoding in WebAssembly…';
  let candidate;
  let images;
  try {
    const file = typeof source === 'string' ? await fetchFile(source, signal) : source;
    if (!file.size) throw new Error('This file is empty. Choose an SVGA animation.');
    if (file.size > MAX_BYTES) throw new Error('This file exceeds the 32 MB preview limit.');
    const buffer = await file.arrayBuffer();
    signal.throwIfAborted();
    $('loading-text').textContent = 'Decoding in WebAssembly…';
    const started = performance.now();
    const { movie, images: assets } = await decodeFile(buffer, signal);
    const decodeMs = performance.now() - started;
    $('loading-text').textContent = 'Preparing the canvas…';
    const prepared = await prepareImages(assets, signal);
    images = prepared.images;
    const warnings = prepared.warnings;
    if (movie.audioCount) warnings.push(`${movie.audioCount} audio track(s) detected. This version previews visuals only.`);
    const missing = new Set(movie.sprites.filter(s => s.image && !images.has(s.key) && !images.has(s.image) && !s.frames.some(f => f.shapes.length)).map(s => s.key));
    if (missing.size) warnings.push(`Missing visual assets: ${[...missing].join(', ')}`);
    candidate = new Renderer(document.createElement('canvas'), movie, images);
    warnings.push(...candidate.warnings);
    candidate.draw(0);
    signal.throwIfAborted();
    state.renderer?.dispose();
    const oldCanvas = $('canvas');
    candidate.canvas.id = 'canvas';
    candidate.canvas.setAttribute('aria-label', 'SVGA animation');
    oldCanvas.replaceWith(candidate.canvas);
    state.renderer = candidate;
    state.movie = movie;
    state.frame = 0;
    candidate = null;
    images = null;
    $('filename').textContent = demo ? 'Orbit.svga' : file.name;
    $('stage-label').textContent = demo ? 'DEMO / ORBIT' : file.name;
    $('stage-note').textContent = demo ? 'Drop your .svga anywhere' : 'Drop another file to replace';
    $('canvas-dimensions').textContent = `${movie.width} × ${movie.height}`;
    $('format-badge').textContent = `SVGA ${movie.version || '—'}`;
    $('detail-size').textContent = `${movie.width} × ${movie.height} px`;
    $('detail-duration').textContent = `${(movie.frames / movie.fps).toFixed(2)} s`;
    $('detail-fps').textContent = `${movie.fps} fps`;
    $('detail-frames').textContent = movie.frames;
    $('detail-layers').textContent = `${movie.sprites.length} / ${assets.filter(a => ['Png', 'Jpeg'].includes(a.kind)).length}`;
    $('detail-bytes').textContent = prettyBytes(file.size);
    $('detail-decode').textContent = `${Math.round(decodeMs)} ms`;
    $('warnings').textContent = warnings.join('\n');
    $('warnings').hidden = warnings.length === 0;
    $('duration').textContent = `${(movie.frames / movie.fps).toFixed(2)}s`;
    $('timeline').max = movie.frames - 1;
    $('zoom').value = 'fit';
    resize();
    draw();
    $('status').textContent = `Loaded ${file.name}. ${movie.frames} frames at ${movie.fps} frames per second.`;
  } catch (error) {
    candidate?.dispose();
    if (!candidate) for (const bitmap of images?.values() || []) bitmap.close();
    if (state.controller === controller && (error.name !== 'AbortError' || signal.reason?.name === 'Error')) showError(signal.reason?.name === 'Error' ? signal.reason : error);
  } finally {
    clearTimeout(networkTimeout);
    if (state.controller === controller) {
      state.controller = null;
      $('loading').hidden = true;
      $('play').disabled = $('timeline').disabled = !state.movie;
      if (!signal.aborted && $('error').hidden && !reducedMotion.matches) play();
    }
  }
}

const openPicker = () => $('file').click();
$('open-file').addEventListener('click', openPicker);
$('browse').addEventListener('click', openPicker);
$('file').addEventListener('change', () => { const file = $('file').files[0]; if (file) load(file); $('file').value = ''; });
$('url-form').addEventListener('submit', event => { event.preventDefault(); load($('url').value.trim()); });
$('demo').addEventListener('click', () => load(new URL('./demo.svga', document.baseURI).href, true));
$('cancel').addEventListener('click', () => state.controller?.abort());
$('play').addEventListener('click', () => state.playing ? pause() : play());
$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('timeline').addEventListener('input', () => { pause(); state.frame = Number($('timeline').value); draw(); });
$('speed').addEventListener('change', () => { const wasPlaying = state.playing; pause(); state.speed = Number($('speed').value); if (wasPlaying) play(); });
$('loop').addEventListener('click', () => { state.loop = !state.loop; $('loop').setAttribute('aria-pressed', state.loop); });
$('zoom').addEventListener('change', resize);
new ResizeObserver(resize).observe($('canvas-space'));
document.querySelectorAll('[data-bg]').forEach(button => button.addEventListener('click', () => {
  $('stage').dataset.background = button.dataset.bg;
  document.querySelectorAll('[data-bg]').forEach(b => b.setAttribute('aria-pressed', b === button));
}));
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, button, a') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); state.playing ? pause() : play(); }
  if (event.code === 'ArrowLeft') { event.preventDefault(); step(-1); }
  if (event.code === 'ArrowRight') { event.preventDefault(); step(1); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
reducedMotion.addEventListener('change', event => { if (event.matches) pause(); });
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); const file = event.dataTransfer.files[0]; if (file) load(file); });
load(new URL('./demo.svga', document.baseURI).href, true);
