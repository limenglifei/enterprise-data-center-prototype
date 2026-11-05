const DEFAULT_DATABASE = 'enterprise-data-center-upload-files-v1';
const STORE = 'files';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function storageError(error, action = '保存上传文件') {
  if (error?.code === 'UPLOAD_FILE_MISSING') return error;
  const detail = error?.name === 'QuotaExceededError'
    ? '浏览器存储空间不足，请释放空间后重试。'
    : '浏览器文件存储不可用，请检查浏览器隐私设置或存储权限后重试。';
  return new Error(`${action}失败：${detail}`, {cause: error});
}

function fileId() {
  if (globalThis.crypto?.randomUUID) return `upload_${globalThis.crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `upload_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}

function missingFileError() {
  const error = new Error('原始文件保存在上传时的浏览器中。当前浏览器未找到该文件，可能已清理本地存储；请在原浏览器下载，或重新上传。');
  error.code = 'UPLOAD_FILE_MISSING';
  return error;
}

function downloadName(name) {
  return String(name || '上传文件').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').slice(0, 240);
}

/** Files stay separate from JSON state so large originals never enter the state API.
 * The optional database name is used by isolated browser tests only.
 */
export function createUploadHistoryStore({indexedDB = globalThis.indexedDB, databaseName = DEFAULT_DATABASE} = {}) {
  let connection;
  const liveURLs = new Set();

  async function database() {
    if (!connection) {
      connection = new Promise((resolve, reject) => {
        if (!indexedDB) { reject(storageError(new Error('IndexedDB unavailable'))); return; }
        let request;
        let settled = false;
        const timeout = setTimeout(() => fail(new Error('IndexedDB open timeout')), 10000);
        const fail = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(storageError(error));
        };
        try { request = indexedDB.open(databaseName, 1); } catch (error) { fail(error); return; }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'fileId'});
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error('IndexedDB upgrade blocked'));
        request.onsuccess = () => {
          const db = request.result;
          if (settled) { db.close(); return; }
          settled = true;
          clearTimeout(timeout);
          db.onversionchange = () => { db.close(); connection = undefined; };
          resolve(db);
        };
      }).catch(error => { connection = undefined; throw error; });
    }
    return connection;
  }

  async function transaction(mode, operation, action) {
    let tx;
    try {
      const db = await database();
      return await new Promise((resolve, reject) => {
        let request;
        try { tx = db.transaction(STORE, mode); request = operation(tx.objectStore(STORE)); }
        catch (error) { reject(error); return; }
        // Resolve on commit rather than request success: a successful put may still abort.
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error || request?.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || request?.error || new Error('IndexedDB transaction aborted'));
      });
    } catch (error) { throw storageError(error, action); }
  }

  async function retainUploadedFile(file) {
    if (!(file instanceof Blob) || typeof file.name !== 'string') throw new Error('请选择本地 xlsx 或 CSV 文件。');
    if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('仅支持 xlsx 或 CSV 文件。');
    if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 20MB 限制。');
    const metadata = {
      fileId: fileId(), name: file.name, size: file.size,
      type: file.type || (/\.xlsx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv'),
      uploadedAt: new Date().toISOString()
    };
    // Keep an immutable Blob clone; JSON metadata is returned only after IndexedDB commits.
    const blob = file.slice(0, file.size, metadata.type);
    await transaction('readwrite', store => store.add({...metadata, blob}), '保存上传文件');
    return metadata;
  }

  async function readUploadedFile(record) {
    const id = typeof record === 'string' ? record : record?.fileId;
    if (!id) throw missingFileError();
    const saved = await transaction('readonly', store => store.get(id), '读取上传文件');
    if (!saved || !(saved.blob instanceof Blob) || saved.blob.size !== saved.size) throw missingFileError();
    return {blob: saved.blob, fileId: saved.fileId, name: saved.name, size: saved.size, type: saved.type, uploadedAt: saved.uploadedAt};
  }

  async function downloadUploadedFile(record) {
    const saved = await readUploadedFile(record);
    if (!globalThis.document?.body || !globalThis.URL?.createObjectURL) throw new Error('当前环境无法下载文件，请使用浏览器打开原型。');
    const url = URL.createObjectURL(saved.blob);
    liveURLs.add(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(saved.name);
    anchor.hidden = true;
    document.body.append(anchor);
    try { anchor.click(); }
    finally {
      anchor.remove();
      // Do not revoke synchronously: the download navigation must first acquire the Blob.
      setTimeout(() => { URL.revokeObjectURL(url); liveURLs.delete(url); }, 60000);
    }
    return {fileId: saved.fileId, name: saved.name, size: saved.size};
  }

  // A file-link click downloads the exact original, including CSV and XLSX binary data.
  const openUploadedFile = downloadUploadedFile;

  async function discardUploadedFile(id) {
    if (typeof id !== 'string' || !id) throw new Error('缺少要回滚的上传文件编号。');
    await transaction('readwrite', store => store.delete(id), '回滚上传文件');
  }

  async function close() {
    if (connection) { try { (await connection).close(); } finally { connection = undefined; } }
    for (const url of liveURLs) URL.revokeObjectURL(url);
    liveURLs.clear();
  }

  return {retainUploadedFile, readUploadedFile, openUploadedFile, downloadUploadedFile, discardUploadedFile, close};
}

let defaultStore;
function store() { return defaultStore ||= createUploadHistoryStore(); }
export const retainUploadedFile = file => store().retainUploadedFile(file);
export const openUploadedFile = record => store().openUploadedFile(record);
export const downloadUploadedFile = record => store().downloadUploadedFile(record);
export const discardUploadedFile = id => store().discardUploadedFile(id);

