import { api, ApiError } from './api.js';

const MAX_RETRIES = 6;
const PAUSED = -1; // pseudo status for an upload aborted by pause()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PUT one chunk at `offset`, reporting bytes sent within the chunk. */
function sendChunk(url, blob, offset, onProgress, onXhr) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr(xhr);
    xhr.open('PUT', url);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new ApiError(xhr.response?.error || `Upload failed (${xhr.status})`, xhr.status, xhr.response));
    };
    xhr.onerror = () => reject(new ApiError('Connection lost', 0));
    xhr.onabort = () => reject(new ApiError('Paused', PAUSED));
    xhr.send(blob);
  });
}

/**
 * One resumable upload. `file` may be null for an upload left over from an earlier visit;
 * it can continue once the same file is picked again (see matches()).
 *
 * state: 'uploading' | 'paused' | 'done' | 'failed'
 */
export class ResumableUpload {
  constructor(channelId, record, file, onChange) {
    this.channelId = channelId;
    this.record = record;
    this.file = file;
    this.onChange = onChange;
    this.offset = record.offset;
    this.sent = record.offset;
    this.state = 'paused';
    this.error = null;
    this.offline = false; // paused automatically after repeated network errors
    this.result = null;
    this.xhr = null;
    this.pauseRequested = false;
  }

  static async create(channelId, file, onChange) {
    const res = await api('POST', `/api/channels/${channelId}/uploads`, {
      name: file.name, size: file.size, lastModified: file.lastModified,
    });
    const up = new ResumableUpload(channelId, res.upload, file, onChange);
    if (res.file) {
      up.state = 'done';
      up.result = res.file;
    }
    return up;
  }

  get id() { return this.record.id; }
  get size() { return this.record.size; }
  get url() { return `/api/channels/${this.channelId}/uploads/${this.id}`; }

  /** Whether `file` is the file this upload was started with. */
  matches(file) {
    if (file.size !== this.size) return false;
    return this.record.lastModified != null ? file.lastModified === this.record.lastModified : file.name === this.record.name;
  }

  emit() { this.onChange?.(this); }

  async syncOffset() {
    const { upload } = await api('GET', this.url);
    this.offset = upload.offset;
    this.sent = upload.offset;
  }

  /** Upload until done, paused or failed. Resolves with the stored file when done. */
  async run(chunkBytes) {
    if (!this.file || this.state === 'uploading' || this.state === 'done') return this.result;
    this.state = 'uploading';
    this.error = null;
    this.offline = false;
    this.pauseRequested = false;
    this.emit();
    let failures = 0;
    while (this.state === 'uploading') {
      if (this.pauseRequested) return this.settle('paused');
      const end = Math.min(this.offset + chunkBytes, this.size);
      try {
        const res = await sendChunk(this.url, this.file.slice(this.offset, end), this.offset,
          (loaded) => { this.sent = this.offset + loaded; this.emit(); }, (xhr) => { this.xhr = xhr; });
        this.offset = res.offset;
        this.sent = res.offset;
        failures = 0;
        if (res.file) {
          this.result = res.file;
          this.settle('done');
          return res.file;
        }
        this.emit();
      } catch (e) {
        if (e.status === PAUSED) {
          await sleep(250); // let the server record how far the aborted chunk got
          await this.syncOffset().catch(() => {});
          return this.settle('paused');
        }
        if (e.status === 409 && e.data?.offset !== undefined) {
          // Out of sync, or the previous chunk is still being written: continue from the server's offset.
          this.offset = e.data.offset;
          this.sent = e.data.offset;
          await sleep(300);
          continue;
        }
        if (e.status === 0 || e.status >= 500 || e.status === 429 || e.message === 'Upload interrupted') {
          if (++failures > MAX_RETRIES) {
            this.offline = true;
            this.error = 'Connection lost. It resumes when you are back online, or press resume.';
            return this.settle('paused');
          }
          await sleep(Math.min(1000 * 2 ** failures, 15_000));
          await this.syncOffset().catch(() => {});
          continue;
        }
        this.error = e.message;
        return this.settle('failed');
      }
    }
    return this.result;
  }

  settle(state) {
    this.state = state;
    this.xhr = null;
    this.emit();
    return this.result;
  }

  pause() {
    if (this.state !== 'uploading') return;
    this.pauseRequested = true;
    this.xhr?.abort();
  }

  async cancel() {
    this.pause();
    for (let i = 0; i < 5; i++) {
      try {
        await api('DELETE', this.url);
        break;
      } catch (e) {
        if (e.status === 404) break;
        await sleep(400); // 409 while the aborted chunk is still being written
      }
    }
    this.canceled = true;
    this.settle('failed');
  }
}
