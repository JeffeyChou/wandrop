// Client-side image compression: pasted screenshots are re-encoded before sending, and image
// files get a small preview while the original is uploaded untouched.

/** Re-encode an image so its longer side is at most maxDim. Resolves null if the browser cannot decode it. */
export async function compressImage(blob, { maxDim = 2048, quality = 0.82 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  // Browsers without a WebP encoder silently return PNG; fall back to JPEG then.
  let out = await encode('image/webp');
  if (!out || out.type !== 'image/webp') out = await encode('image/jpeg');
  return out;
}

export const isImageFile = (file) => /^image\//.test(file.type);
