#!/usr/bin/env node
// Self-contained sanity render: serves sample-assets/ over a throwaway local
// HTTP server (Img/Video assets can't be loaded via file:// — see
// src/types.ts) and renders PersonalizedOutreachVideo with sample-props.json.
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(root, "..");
const assetsDir = path.join(projectDir, "sample-assets");

const MIME = { ".mp3": "audio/mpeg", ".png": "image/png", ".mp4": "video/mp4" };

const server = createServer(async (req, res) => {
  try {
    const filePath = path.join(assetsDir, decodeURIComponent(req.url ?? ""));
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log(`Serving sample-assets/ at http://127.0.0.1:${port}`);

const propsPath = path.join(projectDir, "sample-props.json");
const props = JSON.parse(await readFile(propsPath, "utf8"));
props.hookAudioPath = `http://127.0.0.1:${port}/sample-hook.mp3`;
props.screenAssetPath = `http://127.0.0.1:${port}/sample-screen.png`;

const tmpProps = path.join(projectDir, ".sample-props.render.json");
await writeFile(tmpProps, JSON.stringify(props));

try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["remotion", "render", "src/index.ts", "PersonalizedOutreachVideo", "out/sample.mp4", `--props=${tmpProps}`],
      { cwd: projectDir, stdio: "inherit" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`remotion render exited with code ${code}`))));
    child.on("error", reject);
  });
  console.log("Rendered out/sample.mp4");
} finally {
  server.close();
  await rm(tmpProps, { force: true });
}
