/**
 * dsh-video-read — 视频精读
 *
 * 输入既可以是本地视频文件，也可以是 B站 BV 号 / 分享链接：
 *  - 直链由插件自己调 playurl 接口解析，用户永远不需要手动去解析站扒地址。
 *  - 在线源不下载整段视频：事件扫描走最低清晰度轨，抽帧走最高可用清晰度轨，
 *    靠 ffmpeg 对 DASH 直链做 -ss 定位，只取目标片段。
 *  - 登录态（SESSDATA）是一次性配置，不是每条视频都要操作；不给也能用，只是封顶 480p。
 *
 * 设计原则：源分辨率决定可读性上限，工具如实报告而不是假装读到了。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, platform, homedir } from "node:os";

export const name = "dsh-video-read-learn";
export const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "scripts", "video_engine.py");
const PY_EXE = platform() === "win32" ? "python.exe" : "python3";
const IS_WIN = platform() === "win32";
const PER_PAGE = 4;

let cachedPython = null;
let cachedCookie = null;
// 宿主语音后端状态：一旦准备失败，本次会话不再重试，避免每次调用空等
let speechState = "unknown";

function run(cmd, args, { timeoutMs = 180_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve({ code: -1, stdout: out, stderr: err + "\nTIMEOUT", timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (b) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b) => (err += b.toString("utf8")));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -2, stdout: out, stderr: String(e?.message || e) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

async function pythonWorks(exe) {
  const r = await run(exe, ["-c", "import numpy, PIL; print('ok')"], { timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.includes("ok");
}

async function resolvePython(config) {
  if (cachedPython) return cachedPython;
  const candidates = [];
  if (config?.pythonPath) candidates.push(config.pythonPath);
  if (process.env.DSH_VIDEO_PYTHON) candidates.push(process.env.DSH_VIDEO_PYTHON);

  const runtimeRoots = [];
  if (process.env.DSH_HOME) runtimeRoots.push(join(process.env.DSH_HOME, "dsh-runtimes"));
  runtimeRoots.push(join(homedir(), ".dsh", "dsh-runtimes"));
  for (const root of runtimeRoots) {
    if (!existsSync(root)) continue;
    candidates.push(join(root, "dsh-primary-runtime", "dependencies", "python", PY_EXE));
    try {
      for (const entry of readdirSync(root)) {
        candidates.push(join(root, entry, "dependencies", "python", PY_EXE));
      }
    } catch {}
  }
  candidates.push(IS_WIN ? "py" : "python3", IS_WIN ? "python" : "python", "python3");

  const tried = [];
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes("\\") || c.includes("/")) {
      if (!existsSync(c)) continue;
    }
    tried.push(c);
    if (await pythonWorks(c)) {
      cachedPython = c;
      return c;
    }
  }
  throw new Error(
    `PYTHON_NOT_FOUND: 找不到带 numpy + Pillow 的 Python。已尝试：${tried.join(", ") || "无候选路径"}。`,
  );
}

/** 登录态：只接受 SESSDATA，放进子进程环境变量，不出现在命令行与返回值里。 */
async function resolveCookie(config) {
  if (cachedCookie !== null) return cachedCookie;
  const candidates = [];
  if (config?.cookieFile) candidates.push(config.cookieFile);
  candidates.push(join(homedir(), ".dsh", "bili-sessdata.txt"));
  let raw = process.env.BILI_SESSDATA || "";
  for (const p of candidates) {
    if (raw) break;
    try {
      raw = (await readFile(p, "utf8")).trim();
    } catch {}
  }
  cachedCookie = raw ? (raw.startsWith("SESSDATA=") ? raw : `SESSDATA=${raw}`) : "";
  return cachedCookie;
}

async function engine(args, config, opts) {
  const py = await resolvePython(config);
  const cookie = await resolveCookie(config);
  const env = cookie ? { BILI_SESSDATA: cookie } : undefined;
  const r = await run(py, [ENGINE, ...args], { timeoutMs: opts?.timeoutMs ?? 180_000, env });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || "").trim().slice(-1200);
    throw new Error(`ENGINE_FAILED(${r.code}): ${detail || "无输出"}`);
  }
  const text = r.stdout.trim();
  try {
    return JSON.parse(text.split("\n").filter(Boolean).pop());
  } catch {
    throw new Error(`ENGINE_BAD_JSON: ${text.slice(0, 500)}`);
  }
}

function workDirFor(config, video) {
  // 默认落在持久目录而不是系统临时目录：产物要能复查、能复用
  const base = config?.workDir || join(homedir(), ".dsh", "video-read");
  const tag = video.replace(/[^\w.-]+/g, "_").slice(-60) || "src";
  return join(base, tag);
}

/** 保证返回值是「无损 JSON」：去掉 undefined、把非有限数字收敛成 null。 */
function clean(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "string" || t === "boolean") return value;
  if (Array.isArray(value)) return value.map(clean).filter((x) => x !== undefined);
  if (t === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

const errOut = (e) => clean({ status: "error", reason: String(e?.message || e) });

const VIDEO_DESC =
  "视频来源：B站 BV 号（如 BV1xxxxxxxxx）、https://www.bilibili.com/video/... 链接，或本地文件绝对路径。" +
  "直链由工具自动解析，无需手动准备。在线源目前仅支持哔哩哔哩——其他站点的链接会直接报错，不做猜测解析。";

// --- 内部动作 -----------------------------------------------------------
/** 取字幕（失败返回 null）。字幕是「口述内容」的信息源，和画面证据并列。 */
async function doSubtitle(config, video, biliPage) {
  try {
    const dir = workDirFor(config, video);
    await mkdir(dir, { recursive: true });
    const out = join(dir, "subtitle.json");
    const argv = ["subtitle", String(video), "--out", out];
    if (biliPage) argv.push("--page", String(biliPage));
    await engine(argv, config, { timeoutMs: 120_000 });
    const data = JSON.parse(await readFile(out, "utf8"));
    return data && Array.isArray(data.segments) && data.segments.length ? data : null;
  } catch {
    return null;
  }
}

/** 取某一秒附近的字幕文本：事件时刻往前 6 秒、往后 4 秒，盖住「说完再动手」的顺序。 */
function lineNear(subtitle, at, before = 6, after = 4) {
  const lo = at - before;
  const hi = at + after;
  const parts = subtitle.segments
    .filter((s) => s.end >= lo && s.start <= hi)
    .map((s) => String(s.text || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" ") : "";
}

/** 找本地 whisper.cpp：exe + ggml 模型都齐才算可用。
 *  查找顺序：配置的 whisperDir → 用户数据目录 → 插件自带 vendor → 当前目录。 */
function findWhisper(config) {
  const cands = [];
  if (config?.whisperDir) cands.push(String(config.whisperDir));
  cands.push(join(homedir(), ".dsh", "video-read", "whisper"));
  cands.push(join(HERE, "vendor", "whisper"));
  cands.push(join(process.cwd(), ".whisper"));
  for (const d of cands) {
    for (const sub of ["whispercpp\\Release", "whispercpp", "", "."]) {
      const exe = sub ? join(d, sub, "whisper-cli.exe") : join(d, "whisper-cli.exe");
      const model = join(d, "models", "ggml-small.bin");
      if (existsSync(exe) && existsSync(model)) return { exe, model, dir: d };
    }
  }
  return null;
}

/** 解析 SRT，整体平移到该片段的起始时间。 */
function parseSrt(text, offset = 0) {
  const rows = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const g = m.slice(1).map(Number);
    const s = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000 + offset;
    const e = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000 + offset;
    rows.push({
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      text: lines.slice(2).join(" "),
    });
  }
  return rows;
}

/** 宿主的语音提供方需要先 prepare 才能用；这里等到 ready 或超时。 */
async function ensureSpeechReady(stt, timeoutMs = 240_000) {
  let snap;
  try {
    snap = stt.snapshot?.();
  } catch {}
  const first = snap?.providers?.[0];
  if (!first) return null;
  const phase = first.preparation?.phase;
  if (phase === "ready") return first;
  try {
    stt.prepare?.(first.id);
  } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      snap = stt.snapshot?.();
    } catch {}
    const cur = snap?.providers?.find((p) => String(p.id) === String(first.id));
    const ph = cur?.preparation?.phase;
    if (ph === "ready") return cur;
    if (ph === "failed") throw new Error(`SPEECH_PREPARE_FAILED: ${cur?.preparation?.message ?? ""}`);
  }
  throw new Error("SPEECH_PREPARE_TIMEOUT");
}

/** 解析 whisper.cpp 打印到 stdout 的带时间戳行：[hh:mm:ss.mmm --> hh:mm:ss.mmm] 文本 */
function parseWhisperStdout(text, offset = 0) {
  const rows = [];
  const re = /\[(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)\]\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const g = m.slice(1, 9).map(Number);
    const s = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000 + offset;
    const e = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000 + offset;
    const body = (m[9] || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!body) continue;
    rows.push({
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      text: body,
    });
  }
  return rows;
}

async function doScan(config, { video, top = 24, fps, biliPage, refresh }) {
  const dir = workDirFor(config, video);
  await mkdir(dir, { recursive: true });
  // 同一组参数只扫一次：74 秒的扫描没必要为复查重跑，结果也保持一致（可复现）
  const out = join(dir, `events_f${Number(fps ?? 1)}_t${Number(top)}_p${Number(biliPage ?? 1)}.json`);
  if (!refresh && existsSync(out)) {
    return JSON.parse(await readFile(out, "utf8"));
  }
  const argv = ["scan", video, "--out", out, "--top", String(top)];
  if (fps) argv.push("--fps", String(fps));
  if (biliPage) argv.push("--page", String(biliPage));
  await engine(argv, config, { timeoutMs: 600_000 });
  return JSON.parse(await readFile(out, "utf8"));
}

async function doGrab(config, { video, at, regions, crop, scale, biliPage }) {
  // 固定目录 + --reuse：同一时刻同一区域第二次调用直接复用，离线也能复查
  const cropTag = crop ? "_" + String(crop).replace(/[^0-9.]/g, "") : "";
  const dir = join(workDirFor(config, video), `grab_s${scale}${cropTag}`);
  await mkdir(dir, { recursive: true });
  const argv = ["grab", video, "--at", at.join(","), "--regions", regions,
    "--out", dir, "--scale", String(scale), "--reuse"];
  if (crop) argv.push("--crop", crop);
  if (biliPage) argv.push("--page", String(biliPage));
  const info = await engine(argv, config, { timeoutMs: 300_000 });
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  return { info, all: (manifest.images || []).filter((m) => existsSync(m.file)), manifest };
}

async function attachFrames(attachments, all, page) {
  const slice = all.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const limits = attachments.imageLimits || {};
  const maxBytes = limits.maxImageBytes ?? 5 * 1024 * 1024;
  const inputs = [];
  const picked = [];
  const skipped = [];
  for (const m of slice) {
    const buf = await readFile(m.file);
    if (buf.byteLength > maxBytes) {
      skipped.push(m.file);
      continue;
    }
    inputs.push({ data: new Uint8Array(buf), mediaType: "image/jpeg", name: `${m.region}@${m.at}s` });
    picked.push(m);
  }
  const refs = inputs.length ? await attachments.saveImages(inputs) : [];
  const frames = refs.map((ref, i) => ({
    at: picked[i].at,
    region: picked[i].region,
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name ? { name: ref.name } : {}),
    },
  }));
  return { frames, pageCount: Math.ceil(all.length / PER_PAGE), skipped };
}

const FRAME_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      at: { type: "number" },
      region: { type: "string" },
      image: {
        type: "object",
        properties: {
          attachmentId: { type: "string" },
          mediaType: { type: "string" },
          bytes: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          name: { type: "string" },
        },
        required: ["attachmentId", "mediaType", "bytes", "width", "height"],
      },
    },
    required: ["at", "region", "image"],
  },
};

const renderFrames = (_a, v) => {
  const blocks = [{ type: "text", text: JSON.stringify({ ...v, frames: undefined }, null, 2) }];
  for (const f of v?.frames || []) {
    blocks.push({ type: "text", text: `t=${f.at}s — ${f.region}` });
    blocks.push({ type: "image", attachment: f.image });
  }
  return blocks;
};

/**
 * 音频转写内核：抽音轨 → 切固定长度片段 → 宿主 speechToText 优先，本地 whisper.cpp 兜底。
 *
 * 返回**全量**分段（不分页）：video_asr 在工具层分页，video_outline 需要全量去做段内对齐。
 * 它和画面证据互不依赖，所以可以被并行调用（见 video_outline）。
 */
async function doAsrCore(config, opts, ctx, exec) {
  const video = String(opts?.video ?? "");
  const dir = join(workDirFor(config, video), "audio");
  await mkdir(dir, { recursive: true });
  const localWhisper = findWhisper(config);
  const argv = ["audio", video, "--out", dir, "--segment", String(opts?.segment ?? 0)];
  if (opts?.biliPage) argv.push("--page", String(opts.biliPage));
  await engine(argv, config, { timeoutMs: 900_000 });
  const manifest = JSON.parse(await readFile(join(dir, "audio.json"), "utf8"));

  const stt = ctx?.get?.("speechToText");
  let providers = [];
  if (stt) {
    try {
      providers = stt.listProviders() || [];
    } catch {}
  }

  // 宿主后端只在一开始 prepare 一次；失败后本次会话不再重试，避免每次调用空等
  let hostReady = false;
  if (stt && providers.length && speechState !== "unavailable") {
    try {
      hostReady = Boolean(await ensureSpeechReady(stt, 240_000));
      if (!hostReady) speechState = "unavailable";
    } catch {
      speechState = "unavailable";
      hostReady = false;
    }
  }

  const pickSegments = () => {
    let segs = manifest.segments || [];
    if (opts?.start !== undefined) segs = segs.filter((s) => s.end > Number(opts.start));
    if (opts?.end !== undefined) segs = segs.filter((s) => s.start < Number(opts.end));
    return segs;
  };

  // 宿主没有识别后端时，退回本地 whisper.cpp（离线、免费、带时间戳）
  if (!hostReady) {
    const w = localWhisper;
    if (w) {
      const segs = pickSegments();
      const tmpDir = join(tmpdir(), "dsh-video-read-asr");
      await mkdir(tmpDir, { recursive: true });
      // 每段一个独立文件 + 独立进程，所以可以并发；文件名带 runTag 防止跨调用踩踏。
      const runTag = `${process.pid}_${Date.now().toString(36)}`;
      const concurrency = Math.max(1, Math.min(8, Number(opts?.concurrency ?? 3)));
      const debug = [];
      const chunks = await mapLimit(segs, concurrency, async (s) => {
        if (exec?.signal?.aborted) return [];
        // whisper-cli 把 .srt 写在输入文件旁边，所以要先把 wav 放到可写目录
        const localWav = join(tmpDir, `seg_${runTag}_${String(s.index).padStart(4, "0")}.wav`);
        try {
          await copyFile(s.file, localWav);
        } catch (e) {
          debug.push(`${s.index}: copy ${String(e?.message)}`);
          return [];
        }
        const r = await run(w.exe, ["-m", w.model, "-l", String(opts?.language ?? "zh"),
          "-f", localWav], { timeoutMs: 900_000 });
        if (r.code !== 0) {
          debug.push(`${s.index}: exit ${r.code} ${(r.stderr || "").slice(-160)}`);
          return [];
        }
        // 直接解析 stdout：whisper-cli 的 -osrt 写文件在某些目录下不可靠
        const got = parseWhisperStdout(r.stdout + "\n" + r.stderr, s.start);
        if (!got.length) {
          debug.push(`${s.index}: stdout 无时间戳行 (${(r.stdout || "").length}B)`);
          return [];
        }
        return got;
      });
      const rows = chunks.flat().sort((a, b) => a.start - b.start);
      const out = join(dir, "asr.json");
      await writeFile(out, JSON.stringify({ segments: rows }, null, 2), "utf8");
      return clean({
        status: "ok",
        engine: "local-whisper.cpp",
        engine_dir: w.dir,
        duration: manifest.duration,
        segment_seconds: manifest.segment_seconds,
        segments: rows,
        text: joinTranscript(rows),
        concurrency,
        file: out,
        ...(debug.length ? { debug: debug.slice(0, 10) } : {}),
        note:
          "本地 whisper.cpp 转写（CPU）。机器转写，专有名词可能有错字；" +
          "段与段之间按切片硬切，交界处可能有半句重叠。",
      });
    }
    return clean({
      status: "no_backend",
      audio_file: manifest.audio,
      duration: manifest.duration,
      audio_segments: (manifest.segments || []).length,
      segment_seconds: manifest.segment_seconds,
      segments: [],
      reason:
        (stt
          ? "宿主有 speechToText 服务，但没有注册任何识别后端；本地也没找到 whisper.cpp。"
          : "宿主没有 speechToText 服务，本地也没找到 whisper.cpp。") +
        "音频已经抽好并切好段，可以交给外部工具转写。",
      howto: [
        `音频：${manifest.audio}`,
        `分段：${dir}\\seg_*.wav（16kHz 单声道，每段 ${manifest.segment_seconds} 秒）`,
        "本地引擎放置位置：<whisperDir>\\whispercpp\\Release\\whisper-cli.exe 与 <whisperDir>\\models\\ggml-small.bin",
      ],
    });
  }

  const segs = pickSegments();
  const concurrency = Math.max(1, Math.min(8, Number(opts?.concurrency ?? 3)));
  // 分段并发转写：每段独立 resolve / transcribe，结果按输入顺序回收再按时间排序。
  const parts = await mapLimit(segs, concurrency, async (s) => {
    const buf = await readFile(s.file);
    const spec = stt.resolve({
      audio: new Uint8Array(buf),
      language: String(opts?.language ?? "zh"),
    });
    const provider = String(spec?.provider?.info?.name ?? spec?.provider?.info?.id ?? "");
    const t = await stt.transcribe(spec, exec?.signal);
    return { start: s.start, end: s.end, text: String(t?.text ?? "").trim(), provider };
  });
  parts.sort((a, b) => a.start - b.start);
  const rows = parts.map(({ provider, ...rest }) => rest);
  const usedProvider = parts.find((p) => p.provider)?.provider ?? "";

  const out = join(dir, "asr.json");
  await writeFile(out, JSON.stringify({ segments: rows }, null, 2), "utf8");
  return clean({
    status: "ok",
    providers: providers.map((p) => ({ id: String(p.id), name: p.name, location: p.location })),
    provider: usedProvider,
    fallback_engine: localWhisper ? localWhisper.dir : null,
    duration: manifest.duration,
    segment_seconds: manifest.segment_seconds,
    segments: rows,
    text: joinTranscript(rows),
    concurrency,
    file: out,
    note: "机器转写，专有名词可能有错字；时间戳精度等于切片长度，要更细就减小 segment。",
  });
}

/** video_asr 工具入口：doAsrCore + 分页。 */
async function doAsr(config, args, ctx, exec) {
  const r = await doAsrCore(config, args, ctx, exec);
  if (r.status !== "ok") return r;
  const total = r.segments.length;
  const offset = Math.max(0, Number(args?.offset ?? 0));
  const limit = Math.max(1, Number(args?.limit ?? 40));
  return clean({
    ...r,
    segment_count: total,
    offset,
    limit,
    nextOffset: offset + limit < total ? offset + limit : null,
    segments: r.segments.slice(offset, offset + limit),
  });
}

/** 限定并发数的 map：结果保持输入顺序，超出的排队。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 把分段转写合成一份全文。 */
function joinTranscript(rows) {
  return rows
    .map((r) => String(r.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把一段字幕/转写按 [start, end) 取出拼接文本；没有就返回 null。 */
function textWithin(rows, start, end) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const parts = rows
    .filter((s) => s.end >= start && s.start <= end)
    .map((s) => String(s.text || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/**
 * 启动自检：确认运行环境里能找到 ffmpeg。
 *
 * 发行版默认**不改动用户环境**——只检测，缺失时留一条可操作的警告。
 * 需要插件代为补装时，在 profile 的 cordis.patch.yml 里显式打开：
 *
 *     - id: dsh-video-read-learn
 *       name: dsh-video-read-learn
 *       config:
 *         autoInstallFfmpeg: true
 *
 * 安装目标是当前解释器（DSH runtime 的 Python）里的 imageio_ffmpeg，
 * 它自带 ffmpeg 二进制，装好之后长期可用。
 */
async function checkFfmpeg(config, ctx) {
  let py;
  try {
    py = await resolvePython(config);
  } catch {
    return; // 连 Python 都没有：等工具调用时由 resolvePython 报更准确的错
  }
  const check = await run(py, [
    "-c",
    "import imageio_ffmpeg,os,sys;p=imageio_ffmpeg.get_ffmpeg_exe();sys.exit(0 if p and os.path.isfile(p) else 1)",
  ], { timeoutMs: 30_000 });
  if (check.code === 0) return;

  const hint =
    `未找到 ffmpeg。请执行 "${py} -m pip install imageio_ffmpeg"` +
    "，或把 ffmpeg.exe 加入 PATH。";
  const warn = (msg) => {
    try {
      ctx?.logger?.warn?.(msg);
    } catch {}
  };

  if (config?.autoInstallFfmpeg !== true) {
    warn(`dsh-video-read-learn: ${hint}`);
    return;
  }
  const install = await run(py, [
    "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "imageio_ffmpeg",
  ], { timeoutMs: 300_000 });
  if (install.code !== 0) warn(`dsh-video-read-learn: 自动安装 imageio_ffmpeg 失败。${hint}`);
}

export function apply(ctx, config = {}) {
  // 启动自检（非阻塞）：默认只提示；autoInstallFfmpeg: true 时代为补装。
  void checkFfmpeg(config, ctx).catch(() => {});

  const register = (definition) =>
    ctx.effect(() =>
      ctx.tools.register({
        ...definition,
        execute: async (args, exec) => clean(await definition.execute(args, exec)),
      }),
    );

  const attachments = () => ctx.get?.("attachments");

  // --- video_digest：一条命令从链接拿到关键画面 ---------------------------
  register({
    name: "video_digest",
    description:
      "一条命令从链接直接拿到关键画面：先自动扫描界面变化事件，再对最值得看的时刻抽 UI 裁切，返回图片。" +
      "输出面向快速通读；需要精调某个时刻时用 video_frames。" +
      "直链由工具自动解析，无需手动准备。" +
      "还原的是操作流程（顺序、在哪一步开菜单、哪一步加修改器），而非参数数值——480p 下参数数字不保证可读。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        events: { type: "integer", description: "取几个关键事件，默认 6；每个事件出 1 张" },
        regions: { type: "string", description: "抽哪些区域，默认 \"panel,subtitle\"；可加 status/outliner/full" },
        crop: { type: "string", description: "自定义裁切框 \"x0,y0,x1,y1\"（相对坐标 0-1）；布局不标准时用 full 看一眼再传这里" },
        scale: { type: "number", description: "放大倍数，默认 3" },
        page: { type: "integer", description: "图片分页，默认 0，每页 4 张" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          duration_seconds: { type: "number" },
          source_size: { type: "array", items: { type: "number" } },
          readable_ui: { type: "boolean" },
          picked: { type: "array" },
          total: { type: "number" },
          page: { type: "number" },
          pageCount: { type: "number" },
          nextPage: { description: "下一页页码；null 表示已无更多" },
          files: { type: "array" },
          frames: FRAME_SCHEMA,
          note: { type: "string" },
          advice: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: renderFrames,
    },
    execute: async (args) => {
      try {
        const att = attachments();
        if (!att || typeof att.saveImages !== "function")
          return { status: "error", reason: "宿主没有可用的 attachments 服务，无法把图片交给模型。" };

        const report = await doScan(config, {
          video: args.video,
          top: Math.max(Number(args.events ?? 6) * 3, 24),
          biliPage: args.biliPage,
        });

        // 优先「参数/状态栏变过」的事件，其次持续区间短的（一次性切换而非持续拖拽）
        const all = (report.suggested || []).slice();
        const scored = all
          .map((e) => ({
            e,
            rank: (e.ui ? 100 : 0) + (e.score || 0) - Math.min(30, (e.span?.[1] ?? 0) - (e.span?.[0] ?? 0)) * 0.5,
          }))
          .sort((a, b) => b.rank - a.rank)
          .map((x) => x.e);
        const want = Math.max(1, Number(args.events ?? 6));
        const chosen = [];
        for (const e of scored) {
          if (chosen.some((c) => Math.abs(c.at - e.at) < 20)) continue;
          chosen.push(e);
          if (chosen.length >= want) break;
        }
        const at = chosen.map((e) => e.at);
        if (!at.length) return { status: "error", reason: "扫描没有找到可用事件，试试 video_frames 直接指定时刻。" };
        // 事件时刻取 at 本身：实测字幕/面板在「变化那一秒」出现的概率最高，
        // 取区间中点反而容易落进字幕消失的间隙。
        const grabAt = chosen.map((e) => e.at);

        const { all: imgs, manifest } = await doGrab(config, {
          video: args.video,
          at: grabAt,
          regions: String(args.regions || "panel,subtitle"),
          crop: args.crop,
          scale: Number(args.scale ?? 3),
          biliPage: args.biliPage,
        });
        const page = Math.max(0, Number(args.page ?? 0));
        const { frames, pageCount, skipped } = await attachFrames(att, imgs, page);
        const short = Math.min(...(report.source_size || [0, 0]));
        return {
          status: "frames_ready",
          kind: report.kind,
          duration_seconds: report.duration_seconds,
          source_size: report.source_size,
          readable_ui: short >= 700,
          picked: chosen.map((e, i) => ({ at: e.at, grabbedAt: grabAt[i], score: e.score, span: e.span })),
          total: imgs.length,
          page,
          pageCount,
          nextPage: page + 1 < pageCount ? page + 1 : null,
          files: imgs.map((m) => m.file),
          ...(skipped.length ? { oversized: skipped } : {}),
          frames,
          note: "原分辨率裁切图，非 OCR 文本；图中的数值不保证准确。",
          advice: short >= 700
            ? "清晰度够读界面文字。"
            : `源短边 ${short}px，参数数值可能读不准；要逐字核对需要更高清晰度的源。`,
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 900_000,
  });

  // --- video_sweep：分档加密抽帧 + 拼图 --------------------------------
  register({
    name: "video_sweep",
    description:
      "按区间和步长一次抽一批帧，并拼成带时间标签的大图（默认 4×4）。" +
      "属于「粗扫 / 分档加密」环节：step 通常取 video_scan 的 coverage_plan 里每段的 suggest_step（低/中/高三档约 90 / 35 / 15 秒）。" +
      "在线源逐帧定位，每帧约 0.5 秒。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        start: { type: "number", description: "区间起点（秒）" },
        end: { type: "number", description: "区间终点（秒）；省略则到片尾" },
        step: { type: "number", description: "抽帧间隔（秒），默认 60；按 coverage_plan 的 suggest_step 填" },
        cols: { type: "integer", description: "拼图列数，默认 4" },
        rows: { type: "integer", description: "拼图行数，默认 4" },
        width: { type: "integer", description: "每帧缩放宽度，默认 480" },
        page: { type: "integer", description: "拼图分页，默认 0，每页 2 张" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
      },
      required: ["start"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          window: { type: "array", items: { type: "number" } },
          step: { type: "number" },
          frames: { type: "number" },
          sheets: { type: "number" },
          page: { type: "number" },
          pageCount: { type: "number" },
          nextPage: { description: "下一页页码；null 表示已无更多" },
          files: { type: "array" },
          images: {
            type: "array",
            items: {
              type: "object",
              properties: {
                at: { type: "number" },
                region: { type: "string" },
                image: {
                  type: "object",
                  properties: {
                    attachmentId: { type: "string" },
                    mediaType: { type: "string" },
                    bytes: { type: "integer" },
                    width: { type: "integer" },
                    height: { type: "integer" },
                    name: { type: "string" },
                  },
                  required: ["attachmentId", "mediaType", "bytes", "width", "height"],
                },
              },
              required: ["at", "region", "image"],
            },
          },
          note: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => {
        const blocks = [{ type: "text", text: JSON.stringify({ ...v, images: undefined }, null, 2) }];
        for (const f of v?.images || []) {
          blocks.push({ type: "text", text: `拼图 ${f.at} — ${f.region}` });
          blocks.push({ type: "image", attachment: f.image });
        }
        return blocks;
      },
    },
    execute: async (args) => {
      try {
        const att = attachments();
        if (!att || typeof att.saveImages !== "function")
          return { status: "error", reason: "宿主没有可用的 attachments 服务，无法把图片交给模型。" };
        const dir = join(workDirFor(config, String(args.video ?? "")),
          `sweep_${Math.round(Number(args.start))}_${Math.round(Number(args.end ?? 0))}_${Math.round(Number(args.step ?? 60))}`);
        await mkdir(dir, { recursive: true });
        const argv = ["sweep", String(args.video ?? ""), "--start", String(args.start),
          "--step", String(args.step ?? 60), "--out", dir,
          "--cols", String(args.cols ?? 4), "--rows", String(args.rows ?? 4),
          "--width", String(args.width ?? 480)];
        if (args.end !== undefined) argv.push("--end", String(args.end));
        if (args.biliPage) argv.push("--page", String(args.biliPage));
        const info = await engine(argv, config, { timeoutMs: 900_000 });
        const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
        const sheets = (manifest.sheets || []).filter((s) => existsSync(s.file));
        const perPage = 2;
        const page = Math.max(0, Number(args.page ?? 0));
        const slice = sheets.slice(page * perPage, page * perPage + perPage);
        const limits = att.imageLimits || {};
        const maxBytes = limits.maxImageBytes ?? 5 * 1024 * 1024;
        const inputs = [];
        const picked = [];
        for (const s of slice) {
          const buf = await readFile(s.file);
          if (buf.byteLength > maxBytes) continue;
          inputs.push({ data: new Uint8Array(buf), mediaType: "image/jpeg", name: `sheet-${s.frames}` });
          picked.push(s);
        }
        const refs = inputs.length ? await att.saveImages(inputs) : [];
        const images = refs.map((ref, i) => ({
          at: Number(manifest.start ?? 0) + i * perPage * (Number(args.step ?? 60) * (args.cols ?? 4) * (args.rows ?? 4)),
          region: `sheet-${picked[i].frames}f`,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name ? { name: ref.name } : {}),
          },
        }));
        const pageCount = Math.ceil(sheets.length / perPage);
        return {
          status: "sheets_ready",
          kind: manifest.kind,
          window: [manifest.start, manifest.end],
          step: manifest.step,
          frames: manifest.frames,
          sheets: sheets.length,
          page,
          pageCount,
          nextPage: page + 1 < pageCount ? page + 1 : null,
          files: sheets.map((s) => s.file),
          images,
          note:
            "每张拼图里的格子上有 mm:ss 时间标签。先看整体在干什么、阶段怎么切，" +
            "遇到真正需要细节的格子，再用 video_frames 对那一刻做原分辨率裁切。",
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 960_000,
  });

  // --- video_fetch：落成本地，离线复用 ----------------------------------
  register({
    name: "video_fetch",
    description:
      "把在线源转封装成本地 mp4，只下一次，之后所有工具都能用这个本地路径——断网也能反复读，" +
      "产物留在持久目录里可长期复查。默认取最低清晰度轨（scan，够看流程、体积小），" +
      "要底部字幕更清楚可用 track:\"read\" 取最高可用清晰度。已经下过就直接复用，不重复下载。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        track: { type: "string", enum: ["scan", "read"], description: "scan=最低清晰度（默认，小）；read=最高可用清晰度（大）" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          local_path: { type: "string" },
          bytes: { type: "number" },
          reused: { type: "boolean" },
          track: { type: "string" },
          note: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args) => {
      try {
        const dir = workDirFor(config, String(args.video ?? ""));
        await mkdir(dir, { recursive: true });
        const argv = ["fetch", String(args.video ?? ""), "--out-dir", dir,
          "--track", String(args.track ?? "scan")];
        if (args.biliPage) argv.push("--page", String(args.biliPage));
        const info = await engine(argv, config, { timeoutMs: 900_000 });
        return {
          status: "ok",
          local_path: String(info.out),
          bytes: Number(info.bytes ?? 0),
          reused: Boolean(info.reused),
          track: String(args.track ?? "scan"),
          note:
            "之后把这个 local_path 当作 video 参数传给 scan/sweep/frames 即可离线复用；" +
            "文件留在该目录，不需要时自行删除。",
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 960_000,
  });

  // --- video_subtitle：B站字幕（官方 CC / AI 字幕） ----------------------
  register({
    name: "video_subtitle",
    description:
      "取 B站这一集的字幕：优先官方 CC，其次 AI 字幕（ai-zh），输出带时间戳的分段文本。" +
      "这是「口述内容」最完整的一条通道，比抽帧读画面精确得多。" +
      "B站的字幕是登录后才下发的（接口返回 need_login_subtitle=true，未登录时 subtitles 为空），" +
      "需要 ~/.dsh/bili-sessdata.txt 或环境变量 BILI_SESSDATA。" +
      "分段可能很多，默认只返回前 40 条，用 offset 翻页；完整内容存在返回的 file 里。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: "B站 BV 号或链接（字幕只对在线源有效）" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
        offset: { type: "integer", description: "分段起始位置，默认 0" },
        limit: { type: "integer", description: "本页返回多少条，默认 40" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          route: { type: "string" },
          lan: { type: "string" },
          logged_in: { type: "boolean" },
          need_login_subtitle: { type: "boolean" },
          available: { type: "array" },
          segment_count: { type: "number" },
          offset: { type: "number" },
          limit: { type: "number" },
          nextOffset: { description: "下一页偏移；null 表示已无更多" },
          segments: { type: "array" },
          file: { type: "string" },
          reason: { type: "string" },
          note: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args) => {
      try {
        const dir = workDirFor(config, String(args.video ?? ""));
        await mkdir(dir, { recursive: true });
        const out = join(dir, "subtitle.json");
        const argv = ["subtitle", String(args.video ?? ""), "--out", out];
        if (args.biliPage) argv.push("--page", String(args.biliPage));
        await engine(argv, config, { timeoutMs: 180_000 });
        const full = JSON.parse(await readFile(out, "utf8"));
        const segs = full.segments || [];
        const offset = Math.max(0, Number(args.offset ?? 0));
        const limit = Math.max(1, Number(args.limit ?? 40));
        const page = segs.slice(offset, offset + limit);
        return {
          status: full.route === "none" ? "no_subtitles" : "ok",
          route: full.route,
          lan: full.lan,
          logged_in: full.logged_in,
          need_login_subtitle: full.need_login_subtitle,
          available: full.available || [],
          segment_count: segs.length,
          offset,
          limit,
          nextOffset: offset + limit < segs.length ? offset + limit : null,
          segments: page,
          file: out,
          ...(full.reason ? { reason: full.reason } : {}),
          note: "机器/AI 字幕可能有错字与断句问题，专有名词需回查原片。",
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 240_000,
  });

  // --- video_caption：从画面里读硬字幕 -----------------------------------
  register({
    name: "video_caption",
    description:
      "带硬字幕的视频首选这个：按间隔抽「字幕带」，纵向拼成一条长图，一次读很多条。" +
      "字幕是横向长条，塞进 4×4 网格会被压扁，所以这里改成纵向堆叠、保住原始宽度，每条带 mm:ss。" +
      "适合教程的旁白字幕、对话字幕（连说话人一起拍进画面）；不依赖登录，也没有接口调用。" +
      "默认会把「同一句话」的多帧合并、只留字最全的那张（时间标签旁的 ·N 表示合并了几帧），" +
      "所以打字动画的半句会被自动替换成加载完成的那一帧。" +
      "如果新旧字幕交替覆盖、任何单帧都只显示一部分，用 blend:true 对组内做亮度叠加（视觉暂留）。" +
      "先用 full 看一眼字幕落在哪一带，再用 crop 精确框住；默认按 subtitle 区域。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        start: { type: "number", description: "区间起点（秒），默认 0" },
        end: { type: "number", description: "区间终点（秒）；省略则到片尾" },
        step: { type: "number", description: "抽帧间隔，默认 5 秒；一句话约 3–5 秒，给 4 更稳" },
        crop: { type: "string", description: "字幕带裁切框 \"x0,y0,x1,y1\"（相对坐标 0-1）" },
        region: { type: "string", description: "预设区域名，默认 subtitle" },
        width: { type: "integer", description: "每条字幕的缩放宽度，默认 720" },
        perSheet: { type: "integer", description: "每张长图放几条，默认 10" },
        dedupe: { type: "boolean", description: "同一句话多帧合并、只留字最全的那张，默认 true" },
        blend: { type: "boolean", description: "对合并组做亮度叠加（视觉暂留），用于新旧字幕交替、单帧只显示一部分的情况，默认 false" },
        dedupeThr: { type: "number", description: "强制分句阈值，默认 0（按该视频相邻帧差自适应）" },
        page: { type: "integer", description: "长图分页，默认 0，每页 2 张" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          window: { type: "array", items: { type: "number" } },
          step: { type: "number" },
          frames: { type: "number" },
          sheets: { type: "number" },
          page: { type: "number" },
          pageCount: { type: "number" },
          nextPage: { description: "下一页页码；null 表示已无更多" },
          files: { type: "array" },
          images: { type: "array" },
          note: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => {
        const blocks = [{ type: "text", text: JSON.stringify({ ...v, images: undefined }, null, 2) }];
        for (const f of v?.images || []) {
          blocks.push({ type: "text", text: `字幕条 ${f.at}s — ${f.region}` });
          blocks.push({ type: "image", attachment: f.image });
        }
        return blocks;
      },
    },
    execute: async (args) => {
      try {
        const att = attachments();
        if (!att || typeof att.saveImages !== "function")
          return { status: "error", reason: "宿主没有可用的 attachments 服务。" };
        const dir = join(workDirFor(config, String(args.video ?? "")),
          `caption_${Math.round(Number(args.start ?? 0))}_${Math.round(Number(args.end ?? 0))}_${Math.round(Number(args.step ?? 5))}`);
        await mkdir(dir, { recursive: true });
        const argv = ["caption", String(args.video ?? ""), "--out", dir,
          "--start", String(args.start ?? 0), "--step", String(args.step ?? 5),
          "--width", String(args.width ?? 720), "--per-sheet", String(args.perSheet ?? 10),
          "--region", String(args.region ?? "subtitle")];
        if (args.end !== undefined) argv.push("--end", String(args.end));
        if (args.crop) argv.push("--crop", String(args.crop));
        if (args.biliPage) argv.push("--page", String(args.biliPage));
        if (args.dedupe === false) argv.push("--no-dedupe");
        if (args.blend) argv.push("--blend");
        if (args.dedupeThr) argv.push("--dedupe-thr", String(args.dedupeThr));
        const info = await engine(argv, config, { timeoutMs: 900_000 });
        const manifest = JSON.parse(await readFile(join(dir, "caption.json"), "utf8"));
        const sheets = (manifest.sheets || []).filter((s) => existsSync(s.file));
        const perPage = 2;
        const page = Math.max(0, Number(args.page ?? 0));
        const slice = sheets.slice(page * perPage, page * perPage + perPage);
        const limits = att.imageLimits || {};
        const maxBytes = limits.maxImageBytes ?? 5 * 1024 * 1024;
        const inputs = [];
        const picked = [];
        for (const s of slice) {
          const buf = await readFile(s.file);
          if (buf.byteLength > maxBytes) continue;
          inputs.push({ data: new Uint8Array(buf), mediaType: "image/jpeg", name: `caption-${s.lines}` });
          picked.push(s);
        }
        const refs = inputs.length ? await att.saveImages(inputs) : [];
        const images = refs.map((ref, i) => ({
          at: Number(picked[i].window?.[0] ?? 0),
          region: `${picked[i].lines}条`,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name ? { name: ref.name } : {}),
          },
        }));
        const pageCount = Math.ceil(sheets.length / perPage);
        return {
          status: "captions_ready",
          kind: manifest.kind,
          window: info.window ?? manifest.window,
          step: manifest.step,
          frames: info.frames ?? manifest.frames,
          sheets: sheets.length,
          page,
          pageCount,
          nextPage: page + 1 < pageCount ? page + 1 : null,
          files: sheets.map((s) => s.file),
          images,
          note:
            "每条字幕左侧有 mm:ss。照顺序读下来就是这一段的旁白/对话全文，可直接拼成时间轴。" +
            "AI 对话常是逐字打出，靠前的帧可能只有半句，取最完整的那条。",
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 960_000,
  });

  // --- video_asr：从音轨转写带时间戳的字幕 ------------------------------
  register({
    name: "video_asr",
    description:
      "从视频音轨转写出带时间戳的字幕。做法是把音频按固定长度切片、逐段交给宿主的语音识别服务，" +
      "再把各段结果拼成时间轴——因为宿主转录只给整段文本，没有时间戳。" +
      "这是「没有硬字幕、也没有 CC 字幕」时唯一能拿到口述内容的通道。" +
      "依赖宿主的 speechToText 服务；没有可用后端时明确报告，不会假装转写过。" +
      "切片长度按视频总长自适应，多段并发转写，最后合成「全文 + 时间戳分段」；长视频仍然慢，可以先用 start/end 圈定一段试。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        start: { type: "number", description: "只转写这一段（秒），默认从头" },
        end: { type: "number", description: "转写到这一段（秒），默认到片尾" },
        segment: { type: "number", description: "切片长度（秒）；0（默认）= 按视频总长自适应，显式给值则固定切片" },
        language: { type: "string", description: "语言代码，默认 zh" },
        offset: { type: "integer", description: "结果分页起始，默认 0" },
        limit: { type: "integer", description: "本页返回多少条，默认 40" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          providers: { type: "array" },
          provider: { type: "string" },
          duration: { type: "number" },
          segment_seconds: { type: "number" },
          segment_count: { type: "number" },
          offset: { type: "number" },
          limit: { type: "number" },
          nextOffset: { description: "下一页偏移；null 表示已无更多" },
          segments: { type: "array" },
          text: { type: "string" },
          concurrency: { type: "number" },
          engine: { type: "string" },
          engine_dir: { type: "string" },
          file: { type: "string" },
          note: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args, exec) => {
      try {
        return await doAsr(config, args, ctx, exec);
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 1_800_000,
  });

  // --- video_compose：时间合成 ------------------------------------------
  register({
    name: "video_compose",
    description:
      "把一段区间内的多帧合成一张图（median / average / max / min / union），按镜头自动切分。" +
      "用途：静止页面上的浮动 UI 抖动、逐字打字残影、新旧帧交替覆盖。" +
      "只有 median 在静止页场景验证有效；" +
      "union/average 在整句替换的字幕上会把新旧两句叠成重影——要读整句字幕请用 video_caption。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        start: { type: "number", description: "区间起点（秒）" },
        end: { type: "number", description: "区间终点（秒）" },
        fps: { type: "number", description: "采样帧率，默认 4" },
        mode: {
          type: "string",
          enum: ["median", "average", "max", "min", "union"],
          description: "合成模式，默认 median",
        },
        crop: { type: "string", description: "裁切框 \"x0,y0,x1,y1\"（相对坐标 0-1）" },
        biliPage: { type: "integer", description: "B站分P序号" },
      },
      required: ["video", "start", "end"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          mode: { type: "string" },
          composites: { type: "array" },
          segments: { type: "array" },
          out: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args) => {
      try {
        const tag = workDirFor(config, String(args.video ?? ""));
        const mode = String(args.mode ?? "median");
        const outDir = join(tag, `compose_${mode}`);
        await mkdir(outDir, { recursive: true });
        const argv = ["compose", String(args.video ?? ""),
          "--start", String(args.start), "--end", String(args.end),
          "--fps", String(args.fps ?? 4), "--mode", mode, "--out", outDir];
        if (args.crop) argv.push("--crop", String(args.crop));
        if (args.biliPage) argv.push("--page", String(args.biliPage));
        const r = await engine(argv, config, { timeoutMs: 900_000 });
        return clean({
          status: "ok",
          mode: String(r.mode ?? mode),
          composites: r.composites || [],
          segments: r.segments || [],
          out: outDir,
          cut_threshold: r.cut_threshold ?? null,
          note: "按镜头切分后逐段合成；同段内的 single_*.jpg 是原样单帧，可用于对比合成效果。",
        });
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 1_200_000,
  });

  // --- video_outline：把扫描结果整备成「可成文」的证据 -------------------
  register({
    name: "video_outline",
    description:
      "为教程类视频整备成文证据：按密度段聚合「时间轴 + 事件 + 关键帧 + 字幕 + 音频转写」，并给出方法流程文档模板的路径。" +
      "画面扫描、B站字幕、音频转写三条通道并行跑：画面是主线，另外两条各自独立，失败了也不影响整次阅读。" +
      "它不写笔记，只把材料和骨架摆好，成文交给调用方。" +
      "字幕与音频转写是两条独立的辅助源，都可能有错；两者不一致时以画面证据为准。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        framesPerSection: { type: "integer", description: "每个密度段抽几帧，默认 2" },
        withSubtitle: { type: "boolean", description: "是否同时取 B站字幕（需要登录），默认 true" },
        withAsr: { type: "boolean", description: "是否并行跑音频转写（ASR），默认 true；关掉就只读画面 + B站字幕" },
        asrSegment: { type: "integer", description: "ASR 切片长度（秒）；0（默认）= 按视频总长自适应" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          duration: { type: "number" },
          content_mode: { type: "string" },
          sections: { type: "array" },
          event_count: { type: "number" },
          frame_count: { type: "number" },
          subtitle_route: { type: "string" },
          asr_route: { type: "string" },
          asr_segment_count: { type: "number" },
          asr_reason: { type: "string" },
          template: { type: "string" },
          cross_check: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args, exec) => {
      try {
        // 三条腿同时起跑：画面扫描是主线，B站字幕与音频转写各自独立、互不阻塞。
        // 任何一条辅助通道失败都只是少一个证据源，不会让整次阅读失败。
        const withAsr = args.withAsr !== false;
        const scanP = doScan(config, {
          video: args.video, top: 60, biliPage: args.biliPage,
        });
        const subP = args.withSubtitle === false
          ? Promise.resolve(null)
          : doSubtitle(config, args.video, args.biliPage);
        const asrP = withAsr
          ? doAsrCore(config, {
              video: args.video,
              biliPage: args.biliPage,
              segment: args.asrSegment ?? 0,
            }, ctx, exec).catch((e) => ({ status: "error", reason: String(e?.message ?? e) }))
          : Promise.resolve(null);

        // 画面是主证据：只有 doScan 失败才算整体失败；两条辅助通道各自兜住自己的异常。
        const [report, sub, asr] = await Promise.all([scanP, subP, asrP]);
        const asrSegs = asr && asr.status === "ok" ? asr.segments : [];

        const mode = report.content_mode?.mode;
        let plan = report.coverage_plan || [];
        // 讲解/剪辑类视频按「整屏切换点」分段，一页一帧；密度网格对它没有意义
        if (mode === "slides" && Array.isArray(report.content_mode?.scene_cuts) && report.content_mode.scene_cuts.length) {
          const cuts = report.content_mode.scene_cuts.slice().sort((a, b) => a - b);
          const dur = Number(report.duration_seconds || 0);
          plan = cuts.map((c, i) => ({
            start: Number(c),
            end: i + 1 < cuts.length ? Number(cuts[i + 1]) : dur,
            level: "page",
          }));
        }
        const basePer = Math.max(1, Number(args.framesPerSection ?? 2));
        // 段越长抽越多：2 帧起步，每 3 分钟加 1 帧，最多 6 帧；讲解类每页只取 1 帧
        const framesFor = (p) =>
          p.level === "page" ? 1
            : Math.max(basePer, Math.min(6, Math.ceil((p.end - p.start) / 180)));

        const ats = [];
        for (const p of plan) {
          const span = Math.max(1, p.end - p.start);
          const n = framesFor(p);
          const step = span / (n + 1);
          for (let k = 1; k <= n; k++) ats.push(Math.round(p.start + step * k));
        }
        const uniq = [...new Set(ats)].sort((a, b) => a - b);
        let files = [];
        if (uniq.length) {
          const g = await doGrab(config, {
            video: args.video, at: uniq, regions: "full", scale: 1,
            biliPage: args.biliPage,
          });
          files = g.all.map((m) => ({ at: m.at, file: m.file }));
        }

        const sections = plan.map((p, i) => {
          const segFrames = files.filter((f) => f.at >= p.start && f.at < p.end);
          const segEvents = (report.suggested || []).filter((e) => e.at >= p.start && e.at < p.end);
          return {
            index: i + 1,
            start: p.start,
            end: p.end,
            level: p.level,
            frames: segFrames.map((f) => f.file),
            events: segEvents.slice(0, 8).map((e) => ({ at: e.at, kind: e.kind, span: e.span })),
            // 画面（frames/events）在前，两个辅助文本源并排在后
            subtitle: textWithin(sub?.segments, p.start, p.end),
            asr: textWithin(asrSegs, p.start, p.end),
          };
        });

        return {
          status: "ok",
          duration: report.duration_seconds,
          content_mode: report.content_mode?.mode,
          sections,
          event_count: (report.suggested || []).length,
          frame_count: files.length,
          subtitle_route: sub ? sub.route : "none",
          asr_route: asr ? asr.status : "off",
          asr_segment_count: asrSegs.length,
          ...(asr && asr.status !== "ok" ? { asr_reason: asr.reason } : {}),
          template: join(HERE, "templates", "TUTORIAL_DOC.md"),
          cross_check:
            "字幕与音频转写是两条独立的辅助源，都可能有错；两者不一致时以画面证据为准。",
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 900_000,
  });

  // --- video_probe -------------------------------------------------------
  register({
    name: "video_probe",
    description:
      "解析视频源：时长、读取轨尺寸、B站可用清晰度与登录状态，并判定这个源够不够读界面文字。" +
      "在线源的直链由工具自动解析。源短边低于 700px 时参数数值通常不可读。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始），默认第 1 个" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          source: { type: "string" },
          title: { type: "string" },
          author: { type: "string" },
          duration_seconds: { type: "number" },
          source_size: { type: "array", items: { type: "number" } },
          scan_size: { type: "array", items: { type: "number" } },
          readable_ui: { type: "boolean" },
          logged_in: { type: "boolean" },
          cookie_loaded: { type: "boolean" },
          available_tracks: { type: "array" },
          login_hint: { type: "string" },
          advice: { type: "string" },
          note: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args) => {
      try {
        const argv = ["probe", args.video];
        if (args.biliPage) argv.push("--page", String(args.biliPage));
        const info = await engine(argv, config, { timeoutMs: 180_000 });
        return { status: "ok", ...info, cookie_loaded: Boolean(await resolveCookie(config)) };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 200_000,
  });

  // --- video_scan --------------------------------------------------------
  register({
    name: "video_scan",
    description:
      "扫描全片，输出两份互补的东西：①density/coverage_plan——把时间切成固定区间，" +
      "按加权变化量分低/中/高三档并给每档建议采样间隔（这是保证覆盖的主干）；" +
      "②suggested 事件表——档内最值得单看的时刻（尖峰）。" +
      "事件带 kind：menu(开菜单找命令)/object(新建切换物体)/params(加修改器调参)/scene(大纲变化)/view(只换视图)。" +
      "用法：先看 content_mode——operation(软件操作演示) 就按 coverage_plan 分档抽帧，" +
      "slides(幻灯片/口播) 模式按 scene_cuts 每页取一帧。" +
      "再对 suggested 里的关键时刻用 video_frames 精读。在线源走最低清晰度，不落视频文件。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）" },
        top: { type: "integer", description: "最多返回多少个关键事件，默认 24" },
        fps: { type: "number", description: "每秒采样帧数，默认 1" },
        refresh: { type: "boolean", description: "忽略已缓存的扫描结果，强制重扫（换了算法版本或源更新后用）" },
        withSubtitle: { type: "boolean", description: "是否顺带取 B站字幕并贴到每个事件上，默认 true（未登录时自动跳过）" },
      },
      required: ["video"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          source: { type: "string" },
          duration_seconds: { type: "number" },
          source_size: { type: "array", items: { type: "number" } },
          sampled_seconds: { type: "number" },
          regions: { type: "object" },
          event_clusters: { type: "number" },
          suggested: { type: "array" },
          subtitle_source: { type: "object" },
          density: { type: "object" },
          coverage_plan: { type: "array" },
          content_mode: { type: "object" },
          note: { type: "string" },
          events_file: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
    },
    execute: async (args) => {
      try {
        const report = await doScan(config, {
          video: args.video,
          top: args.top ?? 24,
          fps: args.fps,
          biliPage: args.biliPage,
          refresh: args.refresh,
        });
        // 字幕是第二个信息源：有就贴在事件上，没有就原样返回
        let enhanced = report;
        if (args.withSubtitle !== false) {
          const sub = await doSubtitle(config, args.video, args.biliPage);
          if (sub) {
            enhanced = {
              ...report,
              subtitle_source: {
                route: sub.route,
                lan: sub.lan,
                segment_count: sub.segment_count,
                note: "每个事件多了一个 say 字段：那一刻前后 10 秒的字幕原文，用来对上「他说什么」和「他做什么」。",
              },
              suggested: (report.suggested || []).map((e) => {
                const say = lineNear(sub, e.at);
                return say ? { ...e, say } : e;
              }),
            };
          } else {
            enhanced = {
              ...report,
              subtitle_source: {
                route: "none",
                note: "这集没有取到字幕（未登录时 B站不下发），只有画面证据可用。",
              },
            };
          }
        }
        return { status: "ok", ...enhanced };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 660_000,
  });

  // --- video_frames ------------------------------------------------------
  register({
    name: "video_frames",
    description:
      "在指定时刻抽帧并裁出 UI 区域放大，把图片直接交给模型看。在线源从最高可用清晰度轨远程取帧，" +
      "每帧只下载目标片段（约 0.5 秒），不会把整个视频拉下来。" +
      "regions 可选 panel/props/outliner/status/subtitle/keys/menu/full/center；" +
      "布局不标准时先用 full 看一眼，再用 crop 传 \"x0,y0,x1,y1\"（相对坐标 0-1）精确裁。每页 4 张。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: VIDEO_DESC },
        at: { type: "string", description: "要抽取的时刻，逗号分隔的秒数，例如 \"649,1294\"" },
        regions: { type: "string", description: "逗号分隔的区域名，默认 \"panel,status\"" },
        crop: { type: "string", description: "自定义裁切框 \"x0,y0,x1,y1\"（相对坐标 0-1），会作为一个名为 custom 的区域附加" },
        scale: { type: "number", description: "裁切后的放大倍数，默认 3；源分辨率低时可给 4" },
        page: { type: "integer", description: "图片分页，默认 0，每页 4 张" },
        biliPage: { type: "integer", description: "B站分P序号（从 1 开始）；与图片分页 page 无关" },
      },
      required: ["video", "at"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          kind: { type: "string" },
          read_size: { type: "array", items: { type: "number" } },
          at: { type: "array" },
          regions: { type: "array" },
          total: { type: "number" },
          page: { type: "number" },
          pageCount: { type: "number" },
          nextPage: { description: "下一页页码；null 表示已无更多" },
          files: { type: "array" },
          frames: FRAME_SCHEMA,
          note: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status"],
      },
      render: renderFrames,
    },
    execute: async (args) => {
      try {
        const att = attachments();
        if (!att || typeof att.saveImages !== "function")
          return { status: "error", reason: "宿主没有可用的 attachments 服务，无法把图片交给模型。" };
        const ats = String(args.at)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!ats.length) return { status: "error", reason: "at 为空" };
        const regions = String(args.regions || "panel,status");
        const { info, all, manifest } = await doGrab(config, {
          video: args.video,
          at: ats,
          regions,
          crop: args.crop,
          scale: Number(args.scale ?? 3),
          biliPage: args.biliPage,
        });
        const page = Math.max(0, Number(args.page ?? 0));
        const { frames, pageCount, skipped } = await attachFrames(att, all, page);
        if (!frames.length)
          return {
            status: "error",
            reason: `没有可交付的图片（共 ${all.length} 张，全部超过宿主单图上限）。可降低 scale 后重试。`,
            files: all.map((m) => m.file),
          };
        return {
          status: "frames_ready",
          kind: String(info?.kind ?? manifest.kind ?? "local"),
          read_size: manifest.read_size,
          at: ats.map(Number).filter((n) => Number.isFinite(n)),
          regions: regions.split(",").map((s) => s.trim()),
          total: all.length,
          page,
          pageCount,
          nextPage: page + 1 < pageCount ? page + 1 : null,
          files: all.map((m) => m.file),
          ...(skipped.length ? { oversized: skipped } : {}),
          frames,
          note: "原分辨率裁切图，非 OCR 文本；图中的数值不保证准确。",
        };
      } catch (e) {
        return errOut(e);
      }
    },
    timeoutMs: 360_000,
  });
}
