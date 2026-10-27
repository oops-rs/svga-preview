const identity = [1, 0, 0, 1, 0, 0];
const finite = values => values.every(value => typeof value === 'number' && Number.isFinite(value));
const rgba = color => `rgba(${color.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')},${Math.max(0, Math.min(1, color[3]))})`;

// Read JPEG SOF dimensions before asking the browser to allocate decoded pixels.
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
      return [bytes[offset + 5] * 256 + bytes[offset + 6], bytes[offset + 3] * 256 + bytes[offset + 4]];
    }
    offset += length;
  }
  throw new Error('An embedded JPEG has an invalid size header.');
}

export class Renderer {
  constructor(canvas, movie, images) {
    this.canvas = canvas;
    this.movie = movie;
    this.images = images;
    this.paths = new WeakMap();
    this.clips = new WeakMap();
    canvas.width = Math.ceil(movie.width);
    canvas.height = Math.ceil(movie.height);
    this.context = canvas.getContext('2d');
    this.groups = [];
    this.warnings = [];
    const mattes = new Map(movie.sprites.filter(s => s.isMatte).map(s => [s.key, s]));
    const groups = new Map();
    for (const sprite of movie.sprites) {
      let previous = [];
      for (const frame of sprite.frames) {
        if (!finite([frame.alpha, ...frame.matrix])) throw new Error('The movie contains invalid frame geometry.');
        if (frame.shapes.some(shape => shape.geometry.type === 'keep')) frame.shapes = previous;
        else previous = frame.shapes;
      }
      if (sprite.isMatte) continue;
      if (!sprite.matte) { this.groups.push({ sprites: [sprite] }); continue; }
      if (!mattes.has(sprite.matte)) {
        this.warnings.push(`Missing matte ${sprite.matte}; its layer is shown unmasked.`);
        this.groups.push({ sprites: [sprite] });
        continue;
      }
      if (!groups.has(sprite.matte)) {
        const group = { sprites: [], matte: mattes.get(sprite.matte) };
        groups.set(sprite.matte, group);
        this.groups.push(group);
      }
      groups.get(sprite.matte).sprites.push(sprite);
    }
    if (groups.size) {
      this.layer = this.makeLayer();
      this.mask = this.makeLayer();
    }
  }

  makeLayer() {
    const canvas = document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    return canvas;
  }

  draw(frameIndex) {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const group of this.groups) {
      if (!group.matte) { this.sprite(ctx, group.sprites[0], frameIndex); continue; }
      const layer = this.layer.getContext('2d');
      const mask = this.mask.getContext('2d');
      layer.clearRect(0, 0, this.layer.width, this.layer.height);
      mask.clearRect(0, 0, this.mask.width, this.mask.height);
      for (const sprite of group.sprites) this.sprite(layer, sprite, frameIndex);
      this.sprite(mask, group.matte, frameIndex);
      // Compositing the complete mask clears pixels outside its painted bounds.
      layer.globalCompositeOperation = 'destination-in';
      layer.drawImage(this.mask, 0, 0);
      layer.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.layer, 0, 0);
    }
  }

  sprite(ctx, sprite, index) {
    const frame = sprite.frames[index];
    if (!frame || frame.alpha <= 0) return;
    ctx.save();
    try {
      ctx.globalAlpha = Math.min(1, frame.alpha);
      ctx.transform(...frame.matrix);
      if (frame.clip) {
        if (!this.clips.has(frame)) this.clips.set(frame, new Path2D(frame.clip));
        ctx.clip(this.clips.get(frame));
      }
      // Some 1.x archives store the full `.matte` key; others use its base name.
      const bitmap = this.images.get(sprite.key) || this.images.get(sprite.image);
      // Embedded image coordinates are intrinsic pixels; the frame matrix places them.
      if (bitmap) ctx.drawImage(bitmap, 0, 0);
      for (const shape of frame.shapes) this.shape(ctx, shape);
    } finally { ctx.restore(); }
  }

  shape(ctx, shape) {
    const { geometry: g, style: s, matrix = identity } = shape;
    if (!s || g.type === 'keep') return;
    if (!finite([...matrix, s.width, s.miter, ...s.dash, ...(s.fill || []), ...(s.stroke || [])])) throw new Error('The movie contains invalid shape geometry or styling.');
    let path = this.paths.get(shape);
    if (!path) {
      path = new Path2D();
      if (g.type === 'path') path = new Path2D(g.d);
      else if (g.type === 'rect') {
        if (!finite([g.x, g.y, g.width, g.height, g.radius])) throw new Error('Invalid rectangle geometry.');
        path.roundRect(g.x, g.y, g.width, g.height, Math.max(0, g.radius));
      } else if (g.type === 'ellipse') {
        if (!finite([g.x, g.y, g.rx, g.ry]) || g.rx < 0 || g.ry < 0) throw new Error('Invalid ellipse geometry.');
        path.ellipse(g.x, g.y, g.rx, g.ry, 0, 0, Math.PI * 2);
      }
      this.paths.set(shape, path);
    }
    ctx.save();
    try {
      ctx.transform(...matrix);
      if (s.fill) { ctx.fillStyle = rgba(s.fill); ctx.fill(path); }
      if (s.stroke && s.width > 0) {
        ctx.strokeStyle = rgba(s.stroke);
        ctx.lineWidth = s.width;
        ctx.lineCap = s.cap;
        ctx.lineJoin = s.join;
        ctx.miterLimit = s.miter > 0 ? s.miter : 10;
        ctx.setLineDash(s.dash.slice(0, 2).map(v => Math.max(0, v)));
        ctx.lineDashOffset = s.dash[2];
        ctx.stroke(path);
      }
    } finally { ctx.restore(); }
  }

  dispose() {
    for (const image of this.images.values()) image.close();
    if (this.layer) this.layer.width = this.mask.width = 0;
    this.canvas.width = 0;
  }
}

export async function prepareImages(assets, signal) {
  const images = new Map();
  const warnings = [];
  let pixels = 0;
  try {
    for (const asset of assets) {
      signal.throwIfAborted();
      if (asset.kind === 'Mp3') continue;
      if (!['Png', 'Jpeg'].includes(asset.kind)) {
        warnings.push(`Unavailable image: ${asset.key}`);
        continue;
      }
      const dimensions = asset.kind === 'Jpeg' ? jpegDimensions(asset.data) : asset.dimensions;
      if (!dimensions || dimensions.some(n => n <= 0 || n > 8192) || dimensions[0] * dimensions[1] + pixels > 64_000_000) {
        throw new Error('Embedded images exceed the browser preview memory limit.');
      }
      const bitmap = await createImageBitmap(new Blob([asset.data], { type: asset.kind === 'Png' ? 'image/png' : 'image/jpeg' }));
      pixels += bitmap.width * bitmap.height;
      if (pixels > 64_000_000 || bitmap.width > 8192 || bitmap.height > 8192) {
        bitmap.close();
        throw new Error('Embedded images exceed the browser preview memory limit.');
      }
      images.set(asset.key, bitmap);
      if (asset.animated) warnings.push(`Animated PNG shown as a still: ${asset.key}`);
    }
    signal.throwIfAborted();
    return { images, warnings };
  } catch (error) {
    for (const image of images.values()) image.close();
    throw error;
  }
}
