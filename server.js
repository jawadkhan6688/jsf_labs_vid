const express      = require("express");
const cors         = require("cors");
const { spawn }    = require("child_process");
const { Readable } = require("stream");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    process.env.ALLOWED_ORIGIN ?? "*",
    "http://localhost:3000",
    "https://jsflabs.io"
  ],
  methods: ["POST", "OPTIONS"],
}));

app.use(express.json());

app.get("/health", (req, res) => {
  try {
    const version = execSync("ffmpeg -version 2>&1").toString().split("\n")[0];
    res.json({ status: "ok", ffmpeg: version });
  } catch {
    res.status(500).json({ status: "error", ffmpeg: "not found" });
  }
});

app.post("/trim", async (req, res) => {
  const { url, duration } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }
  if (!duration || typeof duration !== "number" || duration <= 0) {
    return res.status(400).json({ error: "duration must be a positive number" });
  }

  const trimDuration = Math.min(duration, 300);
  const ffmpegPath   = process.env.FFMPEG_PATH ?? "ffmpeg";

  console.log(`[trim] ${trimDuration}s from ${url.slice(0, 80)}…`);

  // ── Fetch source video ────────────────────────────────
  let sourceRes;
  try {
    sourceRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(240_000),
    });
    if (!sourceRes.ok) {
      return res.status(502).json({ error: `Source fetch failed: HTTP ${sourceRes.status}` });
    }
  } catch (e) {
    return res.status(502).json({ error: `Source unreachable: ${e.message}` });
  }

  if (!sourceRes.body) {
    return res.status(502).json({ error: "No response body from source" });
  }

  // ── Spawn FFmpeg ──────────────────────────────────────
  const ffmpeg = spawn(ffmpegPath, [
    "-i",        "pipe:0",
    "-t",        String(trimDuration),
    "-c",        "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f",        "mp4",
    "pipe:1",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // ── EPIPE fix — FFmpeg closes stdin early (by design)
  // when it has collected enough data for the trim duration.
  // Suppress the error so Node doesn't crash.
  ffmpeg.stdin.on("error", (err) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
      // Expected — FFmpeg closed stdin after getting enough data. Fine.
      return;
    }
    console.error("[trim] ffmpeg.stdin unexpected error:", err.message);
  });

  // ── Collect stderr for logging ────────────────────────
  const stderrChunks = [];
  ffmpeg.stderr.on("data", chunk => stderrChunks.push(chunk));

  // ── Pipe: source body → ffmpeg stdin ─────────────────
  const nodeStream = Readable.fromWeb(sourceRes.body);

  // Don't let nodeStream crashing kill the process either
  nodeStream.on("error", (err) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    console.error("[trim] source stream error:", err.message);
    ffmpeg.kill("SIGKILL");
    if (!res.headersSent) {
      res.status(502).json({ error: "Source stream failed" });
    }
  });

  nodeStream.pipe(ffmpeg.stdin, { end: true });

  // ── Set response headers ──────────────────────────────
  res.setHeader("Content-Type",        "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="scene-${trimDuration}s.mp4"`);
  res.setHeader("Cache-Control",       "no-store");

  // ── Pipe: ffmpeg stdout → HTTP response ───────────────
  ffmpeg.stdout.pipe(res);

  // ── FFmpeg exit ───────────────────────────────────────
  ffmpeg.on("close", (code) => {
    if (code !== 0 && code !== null) {
      const stderr = Buffer.concat(stderrChunks).toString().slice(-400);
      console.error(`[trim] FFmpeg exited ${code}:\n${stderr}`);
      if (!res.writableEnded) res.end();
    } else {
      console.log(`[trim] ✓ Done — ${trimDuration}s delivered`);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("[trim] FFmpeg spawn error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "FFmpeg not available on this server" });
    }
  });

  // ── Client disconnect — kill FFmpeg ───────────────────
  req.on("close", () => {
    if (!res.writableEnded) {
      nodeStream.destroy();
      ffmpeg.kill("SIGKILL");
      console.log("[trim] Client disconnected — killed FFmpeg");
    }
  });
});

app.listen(PORT, () => {
  console.log(`JSF Trim Server running on port ${PORT}`);
});