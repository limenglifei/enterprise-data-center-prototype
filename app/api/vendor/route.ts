/** Removed upstream connector boundary. Downstream enterprise APIs are separate routes. */
function removed() {
  return Response.json({
    error: "UPSTREAM_API_REMOVED",
    message: "上游 API 对接已移除，请使用 FTP/FTPS 或离线文件本地上传。",
  }, { status: 410, headers: { "Cache-Control": "no-store" } });
}

export async function GET() { return removed(); }
export async function POST() { return removed(); }
