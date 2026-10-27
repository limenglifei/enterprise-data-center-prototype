import { env } from "cloudflare:workers";

const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_STATE_BYTES + 64 * 1024;
const responseHeaders = { "Cache-Control": "no-store" };

type StateRow = { revision: number; payload: string; updated_at: string };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders });
}

function snapshot(row: StateRow | null) {
  return row
    ? { state: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at }
    : { state: null, revision: 0 };
}

function dbFailure(error?: unknown) {
  const message = error instanceof Error ? error.message : "";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const missingTable = /no such table/i.test(`${message} ${cause}`);
  return json({
    error: missingTable ? "DB_SCHEMA_UNAVAILABLE" : "DB_UNAVAILABLE",
    message: missingTable
      ? "原型数据表尚未就绪，请先应用数据库迁移。"
      : "共享存储暂不可用，请稍后重试。",
  }, 503);
}

async function readBody(request: Request): Promise<string | Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "STATE_TOO_LARGE", message: "单份原型状态不能超过 5 MB。" }, 413);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: "STATE_TOO_LARGE", message: "单份原型状态不能超过 5 MB。" }, 413);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function GET() {
  if (!env.DB) return dbFailure();
  try {
    const row = await env.DB.prepare(
      "SELECT revision, payload, updated_at FROM prototype_state WHERE id = ?",
    ).bind("shared").first<StateRow>();
    return json(snapshot(row));
  } catch (error) {
    return dbFailure(error);
  }
}

export async function PUT(request: Request) {
  let body: { state?: unknown; baseRevision?: unknown };
  try {
    const raw = await readBody(request);
    if (raw instanceof Response) return raw;
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
  } catch {
    return json({ error: "INVALID_JSON", message: "请求内容必须是有效的 JSON 对象。" }, 400);
  }
  if (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0) {
    return json({ error: "INVALID_REVISION", message: "baseRevision 必须是非负整数。" }, 400);
  }
  if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
    return json({ error: "INVALID_STATE", message: "state 必须是原型状态对象。" }, 400);
  }
  const payload = JSON.stringify(body.state);
  if (new TextEncoder().encode(payload).byteLength > MAX_STATE_BYTES) {
    return json({ error: "STATE_TOO_LARGE", message: "单份原型状态不能超过 5 MB。" }, 413);
  }
  if (!env.DB) return dbFailure();
  try {
    const updatedAt = new Date().toISOString();
    // D1 batch executes atomically: concurrent writers cannot both advance one revision.
    const [, updated] = await env.DB.batch<StateRow>([
      env.DB.prepare(
        "INSERT OR IGNORE INTO prototype_state (id, revision, payload, updated_at) VALUES (?, 0, ?, ?)",
      ).bind("shared", "null", updatedAt),
      env.DB.prepare(
        "UPDATE prototype_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? RETURNING revision, payload, updated_at",
      ).bind(payload, updatedAt, "shared", body.baseRevision),
    ]);
    const row = updated.results?.[0] ?? null;
    if (row) return json(snapshot(row));
    const latest = await env.DB.prepare(
      "SELECT revision, payload, updated_at FROM prototype_state WHERE id = ?",
    ).bind("shared").first<StateRow>();
    return json({
      error: "REVISION_CONFLICT",
      message: "状态已被另一窗口更新，请载入最新状态后重试。",
      ...snapshot(latest),
    }, 409);
  } catch (error) {
    return dbFailure(error);
  }
}
