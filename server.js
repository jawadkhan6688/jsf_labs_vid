const express      = require("express");
const cors         = require("cors");
const { spawn }    = require("child_process");
const { Readable } = require("stream");
const { execSync } = require("child_process");

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── Verify FFmpeg on startup ── */
try {
  const version = execSync("ffmpeg -version 2>&1").toString().split("\n")[0];
  console.log("[ffmpeg] ✓", version);
} catch (e) {
  console.error("[ffmpeg] ✗ NOT FOUND — trim requests will fail");
}

/* ── CORS ── */
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      process.env.ALLOWED_ORIGIN,
      "http://localhost:3000",
      "http://localhost:3001",
    ].filter(Boolean);
    if (!origin || allowed.includes(origin) || process.env.ALLOWED_ORIGIN === "*") {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "1mb" }));

/* ─────────────────────────────────────────
   SHARED TRIM LOGIC
   Used by both GET and POST handlers
───────────────────────────────────────── */
async function handleTrim(url, duration, req, res) {
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }
  if (!duration || isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: "duration must be a positive number" });
  }

  const trimDuration = Math.min(Number(duration), 300); // 5 min hard cap
  const ffmpegPath   = process.env.FFMPEG_PATH ?? "ffmpeg";
  const filename     = `scene-${trimDuration}s.mp4`;

  console.log(`[trim] ▶ ${trimDuration}s — ${url.slice(0, 90)}…`);

  /* ── Fetch source video ── */
  let sourceRes;
  try {
    sourceRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(120_000),
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

  /* ── Response headers — triggers browser native download ── */
  res.setHeader("Content-Type",        "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control",       "no-store");
  res.setHeader("X-Accel-Buffering",   "no"); // disable nginx buffering if behind proxy

  /* ── Spawn FFmpeg ── */
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

  /* ── EPIPE: FFmpeg closes stdin early once it has enough data ── */
  ffmpeg.stdin.on("error", (err) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    console.error("[trim] stdin error:", err.message);
  });

  /* ── Stderr for logging only ── */
  const stderrChunks = [];
  ffmpeg.stderr.on("data", chunk => stderrChunks.push(chunk));

  /* ── Pipe: source → ffmpeg stdin ── */
  const nodeStream = Readable.fromWeb(sourceRes.body);

  nodeStream.on("error", (err) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    console.error("[trim] source stream error:", err.message);
    ffmpeg.kill("SIGKILL");
    if (!res.headersSent) res.status(502).json({ error: "Source stream failed" });
  });

  nodeStream.pipe(ffmpeg.stdin, { end: true });

  /* ── Pipe: ffmpeg stdout → response
     This streams directly to the browser — no buffering on our server.
     Browser's native download bar shows real progress. ── */
  ffmpeg.stdout.pipe(res);

  /* ── FFmpeg exit ── */
  ffmpeg.on("close", (code) => {
    if (code !== 0 && code !== null) {
      const stderr = Buffer.concat(stderrChunks).toString().slice(-500);
      console.error(`[trim] ✗ FFmpeg exited ${code}:\n${stderr}`);
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

  /* ── Client disconnect → kill FFmpeg immediately ── */
  req.on("close", () => {
    if (!res.writableEnded) {
      nodeStream.destroy();
      ffmpeg.kill("SIGKILL");
      console.log("[trim] Client disconnected — FFmpeg killed");
    }
  });
}

/* ─────────────────────────────────────────
   GET /health
───────────────────────────────────────── */
app.get("/health", (req, res) => {
  try {
    const version = execSync("ffmpeg -version 2>&1").toString().split("\n")[0];
    res.json({ status: "ok", ffmpeg: version });
  } catch {
    res.status(500).json({ status: "error", ffmpeg: "not found" });
  }
});

/* ─────────────────────────────────────────
   GET /trim?url=...&duration=12
   ─────────────────────────────────────────
   Browser hits this directly via <a href>.
   Native download bar — zero JS buffering.
   This is the fast path users should use.
───────────────────────────────────────── */
app.get("/trim", async (req, res) => {
  const url      = req.query.url;
  const duration = parseFloat(req.query.duration);
  await handleTrim(url, duration, req, res);
});

/* ─────────────────────────────────────────
   POST /trim  { url, duration }
   ─────────────────────────────────────────
   Kept for download-all (ZIP batching)
   which still needs JS fetch + blob.
───────────────────────────────────────── */
app.post("/trim", async (req, res) => {
  const { url, duration } = req.body;
  await handleTrim(url, duration, req, res);
});

/* ── 404 ── */
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

/* ── Global error handler ── */
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

/* ── Start ── */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎬 JSF Trim Server`);
  console.log(`   Port   : ${PORT}`);
  console.log(`   Origin : ${process.env.ALLOWED_ORIGIN ?? "* (all)"}\n`);
});

server.timeout          = 240_000;
server.keepAliveTimeout = 245_000;