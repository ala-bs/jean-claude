const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function getBase64DecodedLength(data: string): number | null {
  const remainder = data.length % 4;
  if (remainder === 1) return null;

  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (padding > 0 && remainder !== 0) return null;

  return padding > 0
    ? (data.length / 4) * 3 - padding
    : Math.floor(data.length / 4) * 3 + Math.max(0, remainder - 1);
}

function validateBase64(data: string, maxDecodedBytes: number): number | null {
  const decodedLength = getBase64DecodedLength(data);
  // Keep size rejection O(1), before scanning attacker-controlled input.
  if (decodedLength === null || decodedLength > maxDecodedBytes) return null;
  if (!BASE64_PATTERN.test(data)) return null;
  return decodedLength;
}

export async function decodeBase64Chunks({
  data,
  maxDecodedBytes,
  chunkSize = 64 * 1024,
  isCancelled,
  yieldBetweenChunks,
}: {
  data: string;
  maxDecodedBytes: number;
  chunkSize?: number;
  isCancelled: () => boolean;
  yieldBetweenChunks: () => Promise<void>;
}): Promise<ArrayBuffer[] | undefined> {
  if (validateBase64(data, maxDecodedBytes) === null) return undefined;

  const alignedChunkSize = Math.max(4, Math.floor(chunkSize / 4) * 4);
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < data.length; offset += alignedChunkSize) {
    if (isCancelled()) return undefined;

    const end = Math.min(offset + alignedChunkSize, data.length);
    const encodedChunk = data
      .slice(offset, end)
      .padEnd(Math.ceil((end - offset) / 4) * 4, '=');
    const decodedChunk = atob(encodedChunk);
    const buffer = new ArrayBuffer(decodedChunk.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < decodedChunk.length; index += 1) {
      bytes[index] = decodedChunk.charCodeAt(index);
    }
    parts.push(buffer);

    if (end < data.length) await yieldBetweenChunks();
  }

  return isCancelled() ? undefined : parts;
}

export async function decodeBase64ToArrayBuffer({
  data,
  maxDecodedBytes,
  signal,
  yieldBetweenChunks,
}: {
  data: string;
  maxDecodedBytes: number;
  signal: AbortSignal;
  yieldBetweenChunks: () => Promise<void>;
}): Promise<ArrayBuffer> {
  const decodedLength = validateBase64(data, maxDecodedBytes);
  if (decodedLength === null) throw new Error('Invalid or oversized base64 payload');

  const output = new Uint8Array(decodedLength);
  const chunkSize = 64 * 1024;
  let outputOffset = 0;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    signal.throwIfAborted();
    const end = Math.min(offset + chunkSize, data.length);
    const encodedChunk = data
      .slice(offset, end)
      .padEnd(Math.ceil((end - offset) / 4) * 4, '=');
    const decodedChunk = atob(encodedChunk);
    for (let index = 0; index < decodedChunk.length; index += 1) {
      output[outputOffset + index] = decodedChunk.charCodeAt(index);
    }
    outputOffset += decodedChunk.length;

    if (end < data.length) await yieldBetweenChunks();
  }

  signal.throwIfAborted();
  return output.buffer;
}
