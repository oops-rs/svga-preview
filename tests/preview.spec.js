import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync, crc32, inflateSync } from 'node:zlib';
import path from 'node:path';

const demoPath = path.resolve('public/demo.svga');

// Independent protobuf fixture writer: assertions exercise the WASM decoder,
// worker transfer, and actual Canvas pixels rather than the UI's own model.
const varint = value => { const bytes = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value); return Buffer.from(bytes); };
const uint = (tag, value) => Buffer.concat([varint(tag * 8), varint(value)]);
const bytes = (tag, value) => { const b = typeof value === 'string' ? Buffer.from(value) : value; return Buffer.concat([varint(tag * 8 + 2), varint(b.length), b]); };
const float = (tag, value) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return Buffer.concat([varint(tag * 8 + 5), b]); };
const message = (...fields) => Buffer.concat(fields);
const color = (r, g, b, a = 1) => message(float(1, r), float(2, g), float(3, b), float(4, a));
const rect = (x, y, w, h, rgba) => message(uint(1, 1), bytes(3, message(float(1, x), float(2, y), float(3, w), float(4, h))), bytes(10, bytes(1, color(...rgba))));
const frame = (shapes, alpha = 1, clip = '') => message(float(1, alpha), bytes(4, clip), ...shapes.map(s => bytes(5, s)));
const sprite = (key, frames, matte = '') => message(bytes(1, key), ...frames.map(f => bytes(2, f)), bytes(3, matte));
const movie = (sprites, frames = 1, images = []) => deflateSync(message(bytes(1, '2.0.0'), bytes(2, message(float(1, 40), float(2, 40), uint(3, 30), uint(4, frames))), ...images.map(([key, data]) => bytes(3, message(bytes(1, key), bytes(2, data)))), ...sprites.map(s => bytes(4, s))));

function pngPixel() {
  const chunk = (type, data) => {
    const body = message(Buffer.from(type), data);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return message(size, body, crc);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return message(Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,255,255,255,255]))), chunk('IEND', Buffer.alloc(0)));
}

function zip(entries) {
  const files = [], directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(content);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    files.push(message(local, filename, data)); directory.push(message(central, filename)); offset += local.length + filename.length + data.length;
  }
  const central = message(...directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return message(...files, central, end);
}

async function ready(page) {
  await page.goto('/');
  // A cold public load includes downloading the WASM module. Match the
  // decoder's time budget instead of assuming localhost's five-second startup.
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('#error')).toBeHidden();
}
async function open(page, buffer, name = 'fixture.svga') {
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.locator('#loading')).toBeHidden();
  expect(await page.locator('#error').innerText()).toBe('');
  await expect(page.locator('#filename')).toHaveText(name);
}
async function pixel(page, x, y) {
  return page.locator('canvas').evaluate((canvas, [x, y]) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
}

test('WASM demo, local file, playback, seeking, backgrounds and zoom', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  expect((await pixel(page, 240, 240))[3]).toBe(255);
  await open(page, readFileSync(demoPath), 'local.svga');
  await expect(page.locator('#detail-frames')).toHaveText('120');
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(page.locator('#frame-label')).toHaveText('FRAME 002 / 120');
  await page.locator('#timeline').fill('60');
  await expect(page.locator('#current-time')).toHaveText('2.00s');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('#timeline').inputValue()).not.toBe('60');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Dark background' }).click();
  await expect(page.locator('#stage')).toHaveAttribute('data-background', 'dark');
  await page.getByLabel('Zoom', { exact: true }).selectOption('2');
  await expect(page.locator('canvas')).toHaveCSS('width', '960px');
  const bounds = await page.evaluate(() => {
    const canvas = document.querySelector('canvas').getBoundingClientRect();
    const box = document.querySelector('#canvas-space').getBoundingClientRect();
    return { x: canvas.left - box.left, y: canvas.top - box.top };
  });
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('URL loading, CORS failure, malformed input and subsequent recovery', async ({ page }) => {
  await ready(page);
  await page.route('https://fixture.example/demo.svga', route => route.fulfill({ body: readFileSync(demoPath), headers: { 'access-control-allow-origin': '*' } }));
  await page.getByLabel('Or load from a URL').fill('https://fixture.example/demo.svga');
  await page.getByRole('button', { name: 'Load URL' }).click();
  await expect(page.locator('#filename')).toHaveText('demo.svga');
  await page.route('https://fixture.example/blocked.svga', route => route.abort('failed'));
  await page.getByLabel('Or load from a URL').fill('https://fixture.example/blocked.svga');
  await page.getByRole('button', { name: 'Load URL' }).click();
  await expect(page.getByRole('alert')).toContainText('CORS');
  await page.locator('#file').setInputFiles({ name: 'bad.svga', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden();
  await open(page, readFileSync(demoPath));
});

test('matte composites a group once and preserves unrelated background; keep works when seeking', async ({ page }) => {
  await ready(page);
  const red = rect(0, 0, 40, 40, [1, 0, 0]);
  const blue = rect(0, 0, 40, 40, [0, 0, 1]);
  const keep = uint(1, 3);
  const buffer = movie([
    sprite('mask.matte', [frame([rect(0, 0, 20, 40, [1, 1, 1])], 0.5), frame([keep], 0.5)]),
    sprite('', [frame([red]), frame([keep])]),
    sprite('', [frame([blue]), frame([keep])], 'mask.matte'),
    sprite('', [frame([blue]), frame([keep])], 'mask.matte'),
  ], 2);
  await open(page, buffer);
  const left = await pixel(page, 10, 10);
  expect(left[0]).toBeGreaterThanOrEqual(126);
  expect(left[2]).toBeGreaterThanOrEqual(126);
  expect(left[3]).toBe(255);
  expect(await pixel(page, 30, 10)).toEqual([255, 0, 0, 255]);
  await page.locator('#timeline').fill('1');
  expect(await pixel(page, 10, 10)).toEqual(left);
});

test('clipping and bitmap decoding render through the same pipeline', async ({ page }) => {
  await ready(page);
  const clipped = movie([sprite('', [frame([rect(0, 0, 40, 40, [0, 1, 0])], 1, 'M0 0H20V40H0Z')])]);
  await open(page, clipped);
  expect(await pixel(page, 10, 10)).toEqual([0, 255, 0, 255]);
  expect(await pixel(page, 30, 10)).toEqual([0, 0, 0, 0]);
  const png = pngPixel();
  await open(page, movie([sprite('pixel', [frame([])])], 1, [['pixel', png]]), 'bitmap.svga');
  expect((await pixel(page, 0, 0))[3]).toBe(255);
});

test('zip containers resolve legacy and binary image assets', async ({ page }) => {
  await ready(page);
  const png = pngPixel();
  const spec = { ver: '1.1.0', movie: { viewBox: { width: 40, height: 40 }, fps: 30, frames: 1 }, images: { pixel: 'pixel' }, sprites: [{ imageKey: 'pixel', frames: [{ alpha: 1 }] }] };
  await open(page, zip([['movie.spec', JSON.stringify(spec)], ['pixel.png', png]]), 'legacy.svga');
  expect((await pixel(page, 0, 0))[3]).toBe(255);
  const binary = inflateSync(movie([sprite('pixel', [frame([])])], 1, [['pixel', Buffer.from('pixel.png')]]));
  await open(page, zip([['movie.binary', binary], ['pixel.png', png]]), 'zip-binary.svga');
  expect((await pixel(page, 0, 0))[3]).toBe(255);
});

test('legacy matte image keys render, and dangling mattes produce a visible warning', async ({ page }) => {
  await ready(page);
  const png = pngPixel();
  await open(page, movie([
    sprite('pixel.matte', [frame([])]),
    sprite('', [frame([rect(0, 0, 40, 40, [1, 0, 0])])], 'pixel.matte'),
  ], 1, [['pixel.matte', png]]), 'matte-image.svga');
  expect(await pixel(page, 0, 0)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 10, 10))[3]).toBe(0);
  await open(page, movie([sprite('', [frame([rect(0, 0, 40, 40, [1, 0, 0])])], 'absent.matte')]), 'missing-matte.svga');
  await expect(page.locator('#warnings')).toContainText('shown unmasked');
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
});

test('invalid geometry and image dimensions are rejected without losing the current preview', async ({ page }) => {
  await ready(page);
  const invalid = movie([sprite('', [frame([rect(0, 0, NaN, 40, [1, 0, 0])])])]);
  await page.locator('#file').setInputFiles({ name: 'invalid.svga', mimeType: 'application/octet-stream', buffer: invalid });
  await expect(page.getByRole('alert')).toContainText('Invalid rectangle');
  const png = pngPixel(); png.writeUInt32BE(9000, 16);
  await page.locator('#file').setInputFiles({ name: 'oversized.svga', mimeType: 'application/octet-stream', buffer: movie([sprite('pixel', [frame([])])], 1, [['pixel', png]]) });
  await expect(page.getByRole('alert')).toContainText('memory limit');
  await expect(page.locator('#filename')).toHaveText('Orbit.svga');
  await open(page, readFileSync(demoPath), 'recovery.svga');
});

test('ablation: removing a matte, clip or keep changes the expected pixels', async ({ page }, testInfo) => {
  await ready(page);
  const red = rect(0, 0, 40, 40, [1, 0, 0]), blue = rect(0, 0, 40, 40, [0, 0, 1]);
  const mask = sprite('mask.matte', [frame([rect(0, 0, 20, 40, [1, 1, 1])])]);
  await open(page, movie([mask, sprite('', [frame([red])]), sprite('', [frame([blue])], 'mask.matte')]), 'baseline.svga');
  const baseline = await pixel(page, 30, 10);
  await open(page, movie([sprite('', [frame([red])]), sprite('', [frame([blue])])]), 'no-matte.svga');
  const noMatte = await pixel(page, 30, 10);
  expect(baseline).toEqual([255, 0, 0, 255]); expect(noMatte).toEqual([0, 0, 255, 255]);
  await open(page, movie([sprite('', [frame([red], 1, 'M0 0H20V40H0Z')])]), 'clip.svga');
  const clipped = await pixel(page, 30, 10);
  await open(page, movie([sprite('', [frame([red])])]), 'no-clip.svga');
  const noClip = await pixel(page, 30, 10);
  expect(clipped[3]).toBe(0); expect(noClip[3]).toBe(255);
  await open(page, movie([sprite('', [frame([red]), frame([uint(1, 3)])])], 2), 'keep.svga');
  await page.locator('#timeline').fill('1');
  const kept = await pixel(page, 10, 10);
  await open(page, movie([sprite('', [frame([red]), frame([])])], 2), 'no-keep.svga');
  await page.locator('#timeline').fill('1');
  const noKeep = await pixel(page, 10, 10);
  expect(kept[3]).toBe(255); expect(noKeep[3]).toBe(0);
  await testInfo.attach('ablation-pixels', { body: JSON.stringify({ baseline, noMatte, clipped, noClip, kept, noKeep }), contentType: 'application/json' });
});

if (process.env.SVGA_BROWSER_SAMPLES) {
  for (const name of readdirSync(process.env.SVGA_BROWSER_SAMPLES).filter(name => name.endsWith('.svga'))) {
    test(`real corpus: ${name}`, async ({ page }) => {
      await ready(page);
      await open(page, readFileSync(path.join(process.env.SVGA_BROWSER_SAMPLES, name)), name);
      const result = await page.evaluate(() => {
        const timeline = document.querySelector('#timeline');
        let visible = false;
        for (let i = 0; i <= Number(timeline.max); i++) {
          timeline.value = i;
          timeline.dispatchEvent(new Event('input'));
          if (i % 10 === 0) {
            const canvas = document.querySelector('canvas');
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            visible ||= pixels.some((value, index) => index % 4 === 3 && value > 0);
          }
        }
        return { visible, error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent };
      });
      expect(result.error).toBeNull(); expect(result.visible).toBe(true);
    });
  }
}

test('file stays local, oversized URLs are rejected, cancellation recovers', async ({ page }) => {
  await ready(page);
  const requests = [];
  page.on('request', request => { if (request.method() !== 'GET') requests.push(request.url()); });
  await open(page, readFileSync(demoPath));
  expect(requests).toEqual([]);
  await page.route('https://fixture.example/huge.svga', route => route.fulfill({ body: 'tiny', headers: { 'content-length': String(40 * 1024 * 1024), 'access-control-allow-origin': '*' } }));
  await page.getByLabel('Or load from a URL').fill('https://fixture.example/huge.svga');
  await page.getByRole('button', { name: 'Load URL' }).click();
  await expect(page.getByRole('alert')).toContainText('32 MB');
  await page.route('https://fixture.example/slow.svga', () => {});
  await page.getByLabel('Or load from a URL').fill('https://fixture.example/slow.svga');
  await page.getByRole('button', { name: 'Load URL' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#loading')).toBeHidden();
  await open(page, readFileSync(demoPath), 'recovered.svga');
});

test('mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Open file', exact: false })).toBeVisible();
});
