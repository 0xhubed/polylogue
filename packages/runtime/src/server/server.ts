import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { EventLog } from "../log/event-log.ts";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer(dbPath: string, opts: { viewerDir?: string; pollMs?: number } = {}): http.Server {
  const log = new EventLog(dbPath, { readonly: true });
  const pollMs = opts.pollMs ?? 500;
  const viewerDir = opts.viewerDir ? resolve(opts.viewerDir) : undefined;

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== "GET") return json(res, 405, { error: "Read-only server: only GET is allowed" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const from = Number(url.searchParams.get("from") ?? 0) || 0;

    if (parts[0] === "runs") {
      if (parts.length === 1) return json(res, 200, log.runs());
      const run = log.run(parts[1]!);
      if (!run) return json(res, 404, { error: "Run not found" });
      if (parts.length === 2) return json(res, 200, run);
      if (parts[2] === "events" && parts.length === 3) return json(res, 200, log.events(run.id, from));
      if (parts[2] === "stream" && parts.length === 3) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let next = from;
        let timer: NodeJS.Timeout | undefined;
        const pump = () => {
          // Runs from a timer after the response has started, so the request-level catch cannot see its errors.
          try {
            for (const s of log.events(run.id, next)) {
              res.write(`id: ${s.seq}\ndata: ${JSON.stringify(s)}\n\n`);
              next = s.seq + 1;
              if (s.event.kind === "run_finished") {
                res.end("event: end\ndata: {}\n\n");
                return;
              }
            }
            timer = setTimeout(pump, pollMs);
          } catch (err) {
            console.error(err);
            clearTimeout(timer);
            res.end();
          }
        };
        req.on("close", () => clearTimeout(timer));
        pump();
        return;
      }
      return json(res, 404, { error: "Not found" });
    }

    if (viewerDir) {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let file = resolve(viewerDir, rel);
      if (file !== viewerDir && !file.startsWith(viewerDir + sep)) return json(res, 404, { error: "Not found" });
      if (!existsSync(file) || !statSync(file).isFile()) {
        if (extname(rel)) return json(res, 404, { error: "Not found" });
        file = join(viewerDir, "index.html");
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    json(res, 404, { error: "Not found" });
  };

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      if (!(err instanceof URIError)) console.error(err);
      if (res.headersSent) return res.end();
      if (err instanceof URIError) return json(res, 400, { error: "Bad request" });
      json(res, 500, { error: "Internal error" });
    }
  });
  server.on("close", () => log.close());
  return server;
}

export async function serve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: "string", default: "4317" }, host: { type: "string", default: "127.0.0.1" }, viewer: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("usage: polylogue serve <runs.sqlite> [--port 4317] [--host 127.0.0.1] [--viewer <dir>]");
  const server = createServer(positionals[0]!, { viewerDir: values.viewer });
  await new Promise<void>((ok) => server.listen(Number(values.port), values.host, ok));
  console.log(`polylogue: serving ${positionals[0]} at http://${values.host}:${values.port}/`);
}
