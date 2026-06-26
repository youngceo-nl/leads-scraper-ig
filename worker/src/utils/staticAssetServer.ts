import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export type StaticAssetServer = {
  /** Returns the http(s) URL to serve `absoluteFilePath` at. */
  urlFor: (absoluteFilePath: string) => string;
  close: () => Promise<void>;
};

/**
 * Remotion's <Img>/<Video> are loaded via the browser DOM, which refuses
 * file:// resources even with web security disabled — only <Audio> goes
 * through Node-side asset extraction. Assets therefore need to be served
 * over plain HTTP for the duration of a render. See remotion/src/types.ts
 * (toMediaSrc).
 *
 * Serves an explicit file map (key -> absolute path) rather than a directory
 * tree, since the assets for one render can live in different places — e.g.
 * per-job generated files under tmp/<jobId>/ alongside the shared base pitch
 * video that lives outside any job directory.
 */
export async function startStaticAssetServer(filePaths: string[]): Promise<StaticAssetServer> {
  const files = new Map<string, string>();
  for (const absolutePath of filePaths) {
    const key = `${files.size}${path.extname(absolutePath)}`;
    files.set(key, absolutePath);
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const key = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\//, "");
      const filePath = files.get(key);
      if (!filePath) throw new Error("unknown asset");
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("static asset server failed to bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const urlByPath = new Map(Array.from(files.entries()).map(([key, absolutePath]) => [absolutePath, `${baseUrl}/${key}`]));

  return {
    urlFor: (absoluteFilePath) => {
      const url = urlByPath.get(absoluteFilePath);
      if (!url) throw new Error(`urlFor: ${absoluteFilePath} was not registered with startStaticAssetServer`);
      return url;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
