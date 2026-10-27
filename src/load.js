export const MAX_BYTES = 32 * 1024 * 1024;

export async function fetchFile(input, signal) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTPS URL without embedded credentials.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Use an HTTPS URL. Insecure HTTP is only allowed for localhost.');
  }
  let response;
  try {
    response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Could not fetch this URL. The server must allow CORS. You can download the file and open it here instead.');
  }
  if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('This file exceeds the 32 MB preview limit.');
  }
  if (!response.body) throw new Error('The server returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('This file exceeds the 32 MB preview limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let name = url.pathname.split('/').pop() || 'remote.svga';
  try { name = decodeURIComponent(name); } catch { /* Keep a malformed escaped filename printable. */ }
  return new File([bytes], name);
}

export function decodeFile(buffer, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./decoder.worker.js', import.meta.url), { type: 'module' });
    const finish = (callback, value) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      callback(value);
    };
    const abort = () => finish(reject, new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(() => finish(reject, new Error('Decoding took too long. Try a smaller file.')), 20_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    worker.onerror = () => finish(reject, new Error('The WASM decoder could not start. Reload the page and try again.'));
    worker.onmessage = ({ data }) => data.error
      ? finish(reject, new Error(data.error)) : finish(resolve, data);
    worker.postMessage(buffer, [buffer]);
  });
}
