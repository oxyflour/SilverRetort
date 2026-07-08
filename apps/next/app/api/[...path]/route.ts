import { NextRequest } from "next/server";

// 运行时读取 API_REWRITE（desktop 注入），standalone 构建下 next.config rewrites
// 会被烘焙无法改端口，因此用 route handler 代理；SSE 流式透传。
export const dynamic = "force-dynamic";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function backendBase(): string {
  const base = process.env.API_REWRITE ?? "http://127.0.0.1:23001/";
  return base.replace(/\/$/, "");
}

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const search = new URL(req.url).search;
  const dest = `${backendBase()}/api/${path.map(encodeURIComponent).join("/")}${search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) headers.set(key, value);
  });

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const res = await fetch(dest, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    // @ts-expect-error -- Node fetch 要求流式 request body 显式声明 duplex
    duplex: hasBody ? "half" : undefined,
    signal: req.signal,
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  res.headers.forEach((value, key) => {
    // fetch 已解压 body，转发原 content-encoding/length 会导致客户端解析失败
    if (!HOP_BY_HOP.has(key) && key !== "content-encoding") {
      responseHeaders.set(key, value);
    }
  });

  return new Response(res.body, { status: res.status, headers: responseHeaders });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
