import {createUploadHistoryStore} from '../public/prototype/upload-history.mjs';

/** Browser-only verification. A unique temporary database prevents touching user history.
 * Run this exported function from a browser module (IndexedDB and File are required).
 */
export async function verifyUploadHistory(indexedDB = globalThis.indexedDB) {
  const databaseName = 'datahub-upload-test-' + crypto.randomUUID();
  const connections = [];
  const adapter = () => {
    const instance = createUploadHistoryStore({indexedDB, databaseName});
    connections.push(instance);
    return instance;
  };
  let checks = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const sameBytes = async (left, right) => {
    const a = new Uint8Array(await left.arrayBuffer()), b = new Uint8Array(await right.arrayBuffer());
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  };
  const content = '\uFEFF企业名称,统一社会信用代码\r\n文件留存测试有限公司,DEMO-UPLOAD-TEST\r\n';
  try {
    const first = adapter();
    const original = new File([content], '企业上传记录测试.csv', {type: 'text/csv;charset=utf-8'});
    const metadata = await first.retainUploadedFile(original);
    assert(metadata.name === original.name && metadata.size === original.size && !!metadata.uploadedAt && !!metadata.fileId, 'Upload metadata must describe the actual original');
    assert(!('blob' in metadata) && !('base64' in metadata), 'JSON metadata must not contain file bytes');
    const initial = await first.readUploadedFile(metadata);
    assert(await sameBytes(initial.blob, original), 'Stored CSV bytes must match the original, including UTF-8 BOM');
    await first.close();
    const reopened = adapter();
    const restored = await reopened.readUploadedFile(metadata);
    assert(await sameBytes(restored.blob, original) && restored.name === original.name, 'Closing and reopening must retain the original file');
    const xlsxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 128, 7]);
    const xlsx = await reopened.retainUploadedFile(new File([xlsxBytes], '二进制样例.xlsx'));
    const storedXlsx = await reopened.readUploadedFile(xlsx);
    assert(await sameBytes(storedXlsx.blob, new Blob([xlsxBytes])), 'XLSX binary bytes must remain unchanged');
    let unsupported = false;
    try { await reopened.retainUploadedFile(new File(['no'], '不支持.txt')); } catch (error) { unsupported = error.message.includes('仅支持'); }
    assert(unsupported, 'Unsupported file extensions must fail explicitly');
    let missing = false;
    try { await reopened.readUploadedFile({fileId: 'other-browser-file'}); } catch (error) { missing = error.code === 'UPLOAD_FILE_MISSING' && error.message.includes('当前浏览器'); }
    assert(missing, 'Missing file bytes must explain the browser storage boundary');
    await reopened.discardUploadedFile(metadata.fileId);
    let discarded = false;
    try { await reopened.readUploadedFile(metadata); } catch (error) { discarded = error.code === 'UPLOAD_FILE_MISSING'; }
    assert(discarded, 'Rollback must remove only the requested file');
    assert((await reopened.readUploadedFile(xlsx)).fileId === xlsx.fileId, 'Rollback must preserve other uploaded files');
    // Inject an API that throws, even when a global browser IndexedDB implementation exists.
    const blocked = createUploadHistoryStore({indexedDB: {open() { throw new DOMException('denied', 'SecurityError'); }}, databaseName: databaseName + '-blocked'});
    let failed = false;
    try { await blocked.retainUploadedFile(original); } catch (error) { failed = error.message.includes('保存上传文件失败'); }
    assert(failed, 'Denied file storage must reject rather than returning successful metadata');
    await blocked.close();
    return {passed: true, checks, storage: 'IndexedDB Blob', temporaryDatabase: databaseName};
  } finally {
    await Promise.all(connections.map(instance => instance.close()));
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Temporary upload-history database deletion was blocked'));
    });
  }
}
