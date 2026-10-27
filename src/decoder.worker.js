import init, { Preview } from '../wasm/pkg/svga_preview_wasm.js';

self.onmessage = async ({ data }) => {
  let preview;
  try {
    await init();
    preview = new Preview(new Uint8Array(data));
    const movie = JSON.parse(preview.metadata());
    const images = movie.images.map(info => ({ ...info, data: preview.image(info.key) }));
    self.postMessage({ movie, images }, images.map(image => image.data.buffer));
  } catch (error) {
    self.postMessage({ error: String(error?.message || error) });
  } finally {
    preview?.free();
  }
};
