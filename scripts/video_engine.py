"""视频精读引擎：在线源解析 + 事件驱动采样 + UI 区域裁切。

子命令:
  resolve <bv|url>                 解析 B站源，列出可用清晰度与两路直链
  probe   <video|bv|url>           时长、源尺寸、清晰度与可读性判定
  scan    <video|bv|url> --out F   界面事件扫描（在线源走最低清晰度，省流量）
  grab    <video|bv|url> --at ...  按时刻抽帧（在线源走最高可用清晰度，只下目标片段）
  sheet   <dir> --out F            同尺寸图片拼接

设计要点:
  - video 参数既可以是本地文件，也可以是 BV 号或 bilibili 链接。
  - 在线源不下载整段视频：ffmpeg 直接对 DASH 直链做 -ss 定位，只取目标 GOP。
  - 扫描轨与读取轨分开：扫描用最低清晰度（连续解码才便宜），读取用最高清晰度。
  - 区域坐标可自定义：不同 UP 的 Blender 工作区布局不一样，预设只是默认值。
"""
import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

# Windows 下 stdout 默认走 cp936，中文 JSON 传给 Node 会乱码；统一成 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

BILI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
BILI_REFERER = "https://www.bilibili.com/"
BILI_API = "https://api.bilibili.com"


# --- ffmpeg 定位 ---------------------------------------------------------
def find_ffmpeg(explicit=""):
    if explicit and os.path.isfile(explicit):
        return explicit
    # 1) imageio_ffmpeg：装在 DSH 的 Python 里，自带 ffmpeg 二进制（推荐方式）。
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass
    # 2) 系统 PATH。
    p = shutil.which("ffmpeg")
    if p:
        return p
    # 这里不自动安装：插件不应擅自改动用户的运行环境。
    raise RuntimeError(
        "FFMPEG_NOT_FOUND: 未找到 ffmpeg。请执行 "
        + '"' + sys.executable + '" -m pip install imageio_ffmpeg'
        + "，或把 ffmpeg.exe 加入 PATH。"
    )


# --- B站在线源 -----------------------------------------------------------
def parse_bvid(spec):
    m = re.search(r"(BV[0-9A-Za-z]{10})", spec)
    if m:
        return m.group(1)
    m = re.search(r"av(\d+)", spec, re.I)
    return m.group(0).lower() if m else None


def is_bili_spec(spec):
    # 本地存在的文件优先：下载到磁盘后路径里常带 BV 号，不能因此又去解析在线源
    if os.path.isfile(spec):
        return False
    return bool(re.search(r"(BV[0-9A-Za-z]{10})", spec)) or "bilibili.com" in spec


def http_json(url, cookie=""):
    headers = {"User-Agent": BILI_UA, "Referer": BILI_REFERER}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def bili_api(path, cookie=""):
    return http_json(BILI_API + path, cookie)


def bili_resolve(spec, cookie="", page=None):
    """返回 {bvid,cid,title,author,duration,tracks,scan_url,read_url,...}。"""
    bvid = parse_bvid(spec)
    if not bvid:
        raise RuntimeError("BVID_NOT_FOUND")
    view = bili_api("/x/web-interface/view?bvid=%s" % bvid, cookie)
    if view.get("code") != 0:
        raise RuntimeError("BILI_VIEW_FAILED(%s): %s" % (view.get("code"), view.get("message")))
    d = view["data"]
    pages = d.get("pages") or []
    if not pages:
        raise RuntimeError("NO_PAGES")
    pg = pages[0]
    if page:
        hit = [p for p in pages if int(p.get("page", 0)) == int(page)]
        if hit:
            pg = hit[0]
    cid = pg["cid"]

    play = bili_api(
        "/x/player/playurl?bvid=%s&cid=%s&qn=127&fnval=4048&fourk=1&platform=pc" % (bvid, cid),
        cookie,
    )
    if play.get("code") != 0:
        raise RuntimeError("BILI_PLAYURL_FAILED(%s): %s" % (play.get("code"), play.get("message")))
    data = play.get("data") or {}
    dash = data.get("dash") or {}
    vids = dash.get("video") or []
    if not vids:
        raise RuntimeError("NO_DASH_TRACKS")

    tracks = []
    for v in vids:
        url = v.get("baseUrl") or v.get("base_url")
        if not url:
            continue
        tracks.append({
            "id": v.get("id"),
            "width": v.get("width"),
            "height": v.get("height"),
            "bandwidth": v.get("bandwidth"),
            "codec": v.get("codecs"),
            "url": url,
        })
    # 同一 (宽,高,codec) 只保留带宽最高的一条
    uniq = {}
    for t in tracks:
        key = (t["width"], t["height"], t["codec"])
        if key not in uniq or (t["bandwidth"] or 0) > (uniq[key]["bandwidth"] or 0):
            uniq[key] = t
    tracks = list(uniq.values())
    tracks.sort(key=lambda t: (min(t["width"], t["height"]), t["bandwidth"] or 0), reverse=True)

    # 音轨：ASR 需要，和视频轨分开取
    audios = dash.get("audio") or []
    audio_track = None
    if audios:
        a = max(audios, key=lambda x: x.get("bandwidth") or 0)
        audio_track = {
            "id": a.get("id"),
            "bandwidth": a.get("bandwidth"),
            "codec": a.get("codecs"),
            "url": a.get("baseUrl") or a.get("base_url"),
        }

    return {
        "kind": "bili",
        "bvid": bvid,
        "cid": cid,
        "page": pg.get("page"),
        "title": d.get("title"),
        "part": pg.get("part"),
        "author": (d.get("owner") or {}).get("name"),
        "duration": float(pg.get("duration") or d.get("duration") or 0),
        "accept_quality": data.get("accept_quality"),
        "logged_in": bool(cookie),
        "tracks": [{k: t[k] for k in ("id", "width", "height", "bandwidth", "codec")} for t in tracks],
        "audio": {k: audio_track[k] for k in ("id", "bandwidth", "codec")} if audio_track else None,
        "scan_url": tracks[-1]["url"],          # 最低清晰度：连续解码省流量
        "read_url": tracks[0]["url"],           # 最高清晰度：抽帧读界面
        "audio_url": audio_track["url"] if audio_track else None,
        "read_size": [tracks[0]["width"], tracks[0]["height"]],
        "scan_size": [tracks[-1]["width"], tracks[-1]["height"]],
    }


class Source:
    """把「本地文件」和「B站直链」抹平成 ffmpeg 可读的两路输入。"""

    def __init__(self, spec, cookie="", page=None, ffmpeg=""):
        self.spec = spec
        self.ff = find_ffmpeg(ffmpeg)
        if is_bili_spec(spec):
            self.info = bili_resolve(spec, cookie, page)
            self.kind = "bili"
            self.scan_path = self.info["scan_url"]
            self.read_path = self.info["read_url"]
            self.duration = self.info["duration"]
            self.size = tuple(self.info["read_size"])
            self.scan_size = tuple(self.info["scan_size"])
        else:
            if not os.path.isfile(spec):
                raise RuntimeError("FILE_NOT_FOUND: %s" % spec)
            self.info = {"kind": "local"}
            self.kind = "local"
            self.scan_path = spec
            self.read_path = spec
            self.duration = duration_of(self.ff, spec)
            self.size = video_size(self.ff, spec)
            self.scan_size = self.size

    def input_args(self, path):
        if self.kind != "bili":
            return []
        return ["-user_agent", BILI_UA, "-headers",
                "Referer: %s\r\n" % BILI_REFERER]


def duration_of(ff, path):
    p = subprocess.run([ff, "-hide_banner", "-i", path], stderr=subprocess.PIPE,
                       stdout=subprocess.DEVNULL)
    m = re.search(rb"Duration: (\d+):(\d+):(\d+)", p.stderr)
    if not m:
        return 0.0
    h, mi, s = map(int, m.groups())
    return float(h * 3600 + mi * 60 + s)


def video_size(ff, path):
    p = subprocess.run([ff, "-hide_banner", "-i", path], stderr=subprocess.PIPE,
                       stdout=subprocess.DEVNULL)
    m = re.search(rb"Stream #0:0.*?(\d{2,5})x(\d{2,5})", p.stderr, re.S)
    if not m:
        return (0, 0)
    return (int(m.group(1)), int(m.group(2)))


# --- 区域模板（相对坐标 x0,y0,x1,y1）------------------------------------
# 默认按 Blender 默认布局：右侧一列上半是大纲、下半是属性面板，底部整条状态栏。
# 不同 UP 的工作区布局差别很大，用 --crop 或 --regions-json 覆盖。
DEFAULT_REGIONS = {
    "full":     (0.00, 0.00, 1.00, 1.00),
    "props":    (0.78, 0.06, 1.00, 1.00),
    "outliner": (0.78, 0.06, 1.00, 0.55),
    "panel":    (0.78, 0.55, 1.00, 1.00),
    "status":   (0.00, 0.85, 1.00, 1.00),
    # 硬字幕带：很多教程 UP 会把解说烧进画面，字号大、480p 也能读，
    # 它是「音频通道」的廉价替代——口述内容直接躺在这里。
    # 这一带同时包含 3D 视口，差分不是纯字幕信号；要可靠取字幕仍需 OCR 或定间隔扫描。
    "subtitle": (0.00, 0.68, 1.00, 0.90),
    "keys":     (0.00, 0.50, 0.30, 0.90),
    "menu":     (0.00, 0.00, 0.60, 0.05),
    "center":   (0.20, 0.10, 0.78, 0.90),
}

REGION_WEIGHT = {
    "panel": 2.2, "props": 2.2, "status": 1.8, "outliner": 1.4,
    "subtitle": 1.5, "keys": 0.7, "menu": 0.5, "full": 0.6, "center": 0.5,
}
SCAN_REGIONS = ["panel", "status", "outliner", "subtitle", "keys", "menu", "full"]

# 只有这些区域参与「事件打分」和「操作分类」。
# keys（Screencast Keys 的鼠标动画）与 subtitle（字幕带含 3D 视口）几乎每秒都在动，
# 只适合观察趋势，不能当判据——否则每个事件都会变成「全区域命中」。
SIGNAL_REGIONS = {"menu", "panel", "props", "outliner", "full", "center", "status"}


def parse_crop(text):
    vals = [float(v) for v in re.split(r"[,\s]+", text.strip()) if v]
    if len(vals) != 4:
        raise SystemExit("--crop 需要 4 个数：x0,y0,x1,y1（相对坐标 0-1）")
    x0, y0, x1, y1 = vals
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise SystemExit("--crop 坐标需满足 0<=x0<x1<=1、0<=y0<y1<=1")
    return (x0, y0, x1, y1)


def scan(ff, src, fps, width, height, regions):
    """流式解码低分辨率灰度帧，逐区域做相邻帧差。在线源走最低清晰度轨。"""
    cmd = [ff, "-hide_banner", "-loglevel", "error"]
    cmd += src.input_args(src.scan_path)
    cmd += ["-i", src.scan_path,
            "-vf", "fps=%s,scale=%d:%d" % (fps, width, height),
            "-pix_fmt", "gray", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_bytes = width * height
    names = list(regions.keys())
    series = {n: [] for n in names}
    prev = None
    idx = 0
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            cur = np.frombuffer(buf, dtype=np.uint8).reshape(height, width)
            if prev is not None:
                for n in names:
                    x0, y0, x1, y1 = regions[n]
                    a = prev[int(y0 * height):int(y1 * height), int(x0 * width):int(x1 * width)]
                    b = cur[int(y0 * height):int(y1 * height), int(x0 * width):int(x1 * width)]
                    series[n].append(float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()))
            prev = cur
            idx += 1
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass
        proc.wait()
    return series, max(1, idx - 1)


def classify_hit(names):
    """按「哪些区域同时变了」推断这一步在干什么。

    只看 SIGNAL_REGIONS：菜单/属性面板/大纲/画面。keys 与 subtitle 噪声太大，
    参与分类会让每一步都变成「全区域命中」。
    """
    n = set(names) & SIGNAL_REGIONS
    if "menu" in n:
        return "menu"          # 打开了菜单：可能在找命令
    if "panel" in n or "props" in n:
        if "outliner" in n:
            return "object"    # 物体+面板同时变：新建/删除/切换物体
        return "params"        # 只有面板变：加修改器或调参数
    if "outliner" in n:
        return "scene"         # 大纲变：物体层级/命名/可见性
    if "full" in n or "center" in n:
        return "view"          # 只有画面变：换视图、转镜头、看整体
    return "mixed"


def detect_mode(series, stats, n):
    """判断这是「软件操作演示」还是「幻灯片/讲解」——两者该用完全不同的采样策略。

    判据不是「UI 区域有没有变化」（任何有文字和图形的视频都会变），
    而是「有没有长期静止的界面框架」：
      软件操作演示 → 面板底色/边框大面积静止，区域差分的 p50 极低（<0.5）
      讲解/剪辑类 → 固定区域里是角色、字幕、截图，一直在动，p50 明显更高
    """
    full = series.get("full") or []
    if not full:
        return "unknown", {}
    arr = np.asarray(full, dtype=np.float64)
    thr = max(float(np.percentile(arr, 99)), 12.0)
    cuts = (np.where(arr > thr)[0] + 1).tolist()
    gaps = [cuts[i + 1] - cuts[i] for i in range(len(cuts) - 1)]
    med_gap = float(np.median(gaps)) if gaps else 0.0

    ui_keys = [k for k in ("panel", "props", "outliner") if k in stats]
    ui_p50 = min(stats[k]["p50"] for k in ui_keys) if ui_keys else 99.0
    ui_events = sum(stats[k]["events"] for k in ("panel", "props", "outliner", "menu") if k in stats)
    ui_rate = ui_events / max(1, n)

    if ui_p50 < 0.5 and ui_rate >= 0.03:
        mode = "operation"
        advice = (
            "软件操作演示：界面框架长期静止、面板内容频繁变化。"
            "coverage_plan 分档抽帧适合看整体流程，suggested 里的关键时刻适合做原分辨率裁切。"
        )
    elif len(cuts) >= 8:
        mode = "slides"
        advice = (
            "讲解/剪辑类：没有静止的界面框架，画面按整屏切换推进（固定场景换内容、换截图）。"
            "密度网格抽帧会落在切换空档里；切换点以 scene_cuts 为准，每次切换一帧 full。"
            "文字信息通常就在整屏里。"
        )
    else:
        mode = "mixed"
        advice = (
            "混合模式：界面事件与整屏切换两类信号相当。"
            "coverage_plan 适合先做分档粗扫判断内容，之后按切换点切分或按事件加密都可用。"
        )
    return mode, {
        "mode": mode,
        "ui_static_p50": round(ui_p50, 3),
        "scene_cuts": [int(c) for c in cuts[:400]],
        "scene_cut_count": len(cuts),
        "scene_cut_rate": round(len(cuts) / max(1, n), 4),
        "median_cut_gap": round(med_gap, 1),
        "ui_event_rate": round(ui_rate, 4),
        "advice": advice,
    }


def density_buckets(series, n, bucket=300):
    """把全片切成固定区间，按「信号区域」的加权变化量给每档定级。

    这是原方法里「粗扫 → 分段 → 密度档 → 分档加密」的自动化版本：
    区间密度是连续覆盖，事件只是其中的尖峰；两者互补，缺一个都会漏。
    返回每档的 level 与建议采样间隔。
    """
    total = None
    for name, d in series.items():
        if name not in SIGNAL_REGIONS or not d:
            continue
        arr = np.asarray(d, dtype=np.float64) * REGION_WEIGHT.get(name, 1.0)
        total = arr.copy() if total is None else total + arr
    if total is None:
        return [], {}
    rows = []
    for i in range(0, len(total), bucket):
        seg = total[i:i + bucket]
        if seg.size == 0:
            continue
        rows.append({
            "start": int(i),
            "end": int(min(n, i + bucket)),
            "score": round(float(seg.mean()), 2),
            "peak": round(float(seg.max()), 2),
        })
    if not rows:
        return [], {}
    scores = np.asarray([r["score"] for r in rows])
    p33, p66 = (float(np.percentile(scores, q)) for q in (33, 66))
    for r in rows:
        if r["score"] >= p66:
            r["level"], r["suggest_step"] = "high", 15
        elif r["score"] >= p33:
            r["level"], r["suggest_step"] = "mid", 35
        else:
            r["level"], r["suggest_step"] = "low", 90
    meta = {
        "bucket_seconds": bucket,
        "p33": round(p33, 2),
        "p66": round(p66, 2),
        "note": "high/mid/low 按全片分位切档；suggest_step 是这一档建议的抽帧间隔（秒）。"
                "粗扫保证覆盖，分档加密保证细节，事件表负责挑出档内最值得单看的时刻。",
    }
    return rows, meta


def build_plan(buckets):
    """把相邻同档区间合并成「采样计划」：这段用什么间隔抽、大概几张。"""
    plan = []
    for b in buckets:
        if plan and plan[-1]["level"] == b["level"] and b["start"] - plan[-1]["end"] <= 1:
            plan[-1]["end"] = b["end"]
        else:
            plan.append({"start": b["start"], "end": b["end"],
                         "level": b["level"], "suggest_step": b["suggest_step"]})
    for p in plan:
        dur = max(1, p["end"] - p["start"])
        p["frames"] = int(math.ceil(dur / p["suggest_step"]))
    return plan


def analyse(series, n, top, gap=8):
    """各区域用自身 p90*1.2 作阈值，再把命中点按时间聚成事件簇。"""
    stats, points = {}, []
    for name, d in series.items():
        if not d:
            continue
        arr = np.asarray(d)
        p50, p90, p99 = (float(np.percentile(arr, q)) for q in (50, 90, 99))
        thr = max(p90 * 1.2, 0.30 if name != "full" else 1.5)
        idx = np.where(arr > thr)[0] + 1
        stats[name] = {"p50": round(p50, 3), "p90": round(p90, 3), "p99": round(p99, 3),
                       "threshold": round(thr, 3), "events": int(idx.size)}
        for i in idx:
            points.append((int(i), name))

    points.sort(key=lambda p: p[0])
    clusters = []
    for at, name in points:
        if clusters and at - clusters[-1]["last"] <= gap:
            c = clusters[-1]
            c["last"] = at
            c["hits"].append((at, name))
        else:
            clusters.append({"last": at, "hits": [(at, name)]})

    events = []
    for c in clusters:
        names = {h[1] for h in c["hits"]}
        signal = names & SIGNAL_REGIONS
        score = sum(REGION_WEIGHT.get(x, 1.0) for x in signal) if signal else 0.5
        best = max(c["hits"], key=lambda h: REGION_WEIGHT.get(h[1], 1.0))
        events.append({
            "at": int(best[0]),
            "score": round(score, 2),
            "kind": classify_hit(names),
            "regions": sorted(signal),
            "ui": bool(signal & {"panel", "props", "status"}),
            "span": [int(c["hits"][0][0]), int(c["hits"][-1][0])],
        })

    ranked = sorted(events, key=lambda e: e["score"], reverse=True)
    picked = []
    for e in ranked:
        if any(abs(e["at"] - p["at"]) < 20 for p in picked):
            continue
        picked.append(e)
        if len(picked) >= top:
            break
    picked.sort(key=lambda e: e["at"])
    return stats, picked, len(events)


# --- 子命令 --------------------------------------------------------------
def cmd_resolve(args):
    info = bili_resolve(args.spec, args.cookie or os.environ.get("BILI_SESSDATA", ""), args.page)
    public = dict(info)
    public.pop("scan_url", None)
    public.pop("read_url", None)
    print(json.dumps(public, ensure_ascii=False, indent=2))


def cmd_probe(args):
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    short = min(src.size) if src.size[0] else 0
    readable = short >= 700
    out = {
        "ok": True,
        "kind": src.kind,
        "source": args.video,
        "duration_seconds": round(src.duration, 2),
        "source_size": list(src.size),
        "readable_ui": readable,
        "ffmpeg": src.ff,
    }
    if src.kind == "bili":
        out.update({
            "bvid": src.info["bvid"], "cid": str(src.info["cid"]),
            "title": src.info["title"], "part": src.info["part"],
            "author": src.info["author"],
            "logged_in": src.info["logged_in"],
            "available_tracks": src.info["tracks"],
            "scan_size": list(src.scan_size),
            "note": "在线源不下载整段视频：扫描走最低清晰度，抽帧走最高可用清晰度，均只取目标片段。",
        })
        if not src.info["logged_in"]:
            out["login_hint"] = (
                "未登录时 B站只下发 480p 及以下。要读清界面里的参数数值，"
                "需要提供登录态：设置环境变量 BILI_SESSDATA（浏览器 Cookie 里的 SESSDATA 值）。"
            )
    out["advice"] = (
        "源分辨率足以连参数数值一起读。"
        if readable else
        "源短边仅 %dpx：菜单、修改器名、物体名、模式切换这些粗粒度信息仍然可读，"
        "足够还原操作流程；但参数框里的数字不保证读准。" % short
    )
    print(json.dumps(out, ensure_ascii=False))


def cmd_scan(args):
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    regions = dict(DEFAULT_REGIONS)
    if args.regions_json:
        regions = {k: tuple(v) for k, v in json.loads(args.regions_json).items()}
    regions = {k: v for k, v in regions.items() if k in SCAN_REGIONS}
    series, n = scan(src.ff, src, args.fps, args.width, args.height, regions)
    stats, picked, clusters = analyse(series, n, args.top)
    buckets, bucket_meta = density_buckets(series, n, args.bucket)
    mode, mode_info = detect_mode(series, stats, n)
    # 讲解/剪辑类视频没有「菜单/参数面板」这些语义，事件类型统一记作场景切换，
    # 免得输出一堆无意义的 menu，让人误以为那一步在操作软件。
    if mode == "slides":
        for e in picked:
            e["kind"] = "scene"
        for e in picked:
            e["regions"] = [r for r in e.get("regions", []) if r == "full"] or ["full"]
    report = {
        "ok": True,
        "kind": src.kind,
        "source": args.video,
        "duration_seconds": round(src.duration, 2),
        "source_size": list(src.size),
        "sampled_seconds": n,
        "regions": stats,
        "event_clusters": clusters,
        "suggested": picked,
        "density": {"meta": bucket_meta, "buckets": buckets},
        "coverage_plan": build_plan(buckets),
        "content_mode": mode_info,
        "note": "suggested 是界面状态真正发生变化的时刻；ui=true 表示参数面板或状态栏变了，"
                "最值得用 grab 取原分辨率裁切。span 是该事件持续的秒区间。",
    }
    if src.kind == "bili":
        report["scanned_at"] = list(src.scan_size)
    out = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)
        print(json.dumps({"ok": True, "out": args.out, "suggested": len(picked),
                          "duration_seconds": round(src.duration, 2)}, ensure_ascii=False))
    else:
        print(out)


def cmd_grab(args):
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    regions = dict(DEFAULT_REGIONS)
    if args.regions_json:
        regions = {k: tuple(v) for k, v in json.loads(args.regions_json).items()}
    if args.crop:
        regions["custom"] = parse_crop(args.crop)
    names = [r.strip() for r in args.regions.split(",") if r.strip()]
    for n in names:
        if n not in regions:
            raise SystemExit("unknown region: %s (have: %s)" % (n, ", ".join(sorted(regions))))
    ats = [float(v) for v in args.at.split(",") if v.strip()]
    os.makedirs(args.out, exist_ok=True)
    w, h = src.size
    made = []
    for at in ats:
        for n in names:
            x0, y0, x1, y1 = regions[n]
            cw = max(1, int(round((x1 - x0) * w)))
            ch = max(1, int(round((y1 - y0) * h)))
            vf = "crop=iw*%.4f:ih*%.4f:iw*%.4f:ih*%.4f" % (x1 - x0, y1 - y0, x0, y0)
            # 整帧已经够大，再放大只浪费 token；字幕带同理不需要过度放大
            s = args.scale
            if n == "full" and s > 1.5:
                s = 1.5
            if s and s != 1:
                vf += ",scale=%d:%d:flags=lanczos" % (int(cw * s), int(ch * s))
            name = "%s_%07.1f.jpg" % (n, at)
            dst = os.path.join(args.out, name)
            # 复用：同一时刻、同一区域已经抽过的帧直接跳过（离线复查、反复调用都靠它）
            if args.reuse and os.path.isfile(dst) and os.path.getsize(dst) > 0:
                made.append({"at": at, "region": n, "file": dst,
                             "bytes": os.path.getsize(dst), "reused": True})
                continue
            cmd = [src.ff, "-hide_banner", "-loglevel", "error"]
            cmd += src.input_args(src.read_path)
            cmd += ["-ss", "%.3f" % at, "-i", src.read_path, "-frames:v", "1",
                    "-vf", vf, "-q:v", str(args.quality), "-y", dst]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.isfile(dst) and os.path.getsize(dst) > 0:
                made.append({"at": at, "region": n, "file": dst,
                             "bytes": os.path.getsize(dst)})
    manifest = {"ok": True, "kind": src.kind, "source": args.video,
                "read_size": [w, h], "scale": args.scale, "images": made}
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "out": args.out, "count": len(made),
                      "read_size": [w, h],
                      "files": [m["file"] for m in made]}, ensure_ascii=False))


def pack_images(frames_dir, out, cols, rows, start, step, cell_w=400, label=True):
    """把抽好的帧拼成 4×4 大图，每格带时间标签。用于粗扫/分档加密。"""
    files = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith((".jpg", ".png")))
    if not files:
        return []
    per = max(1, cols * rows)
    cell_h = int(cell_w * 9 / 16)
    made = []
    for sheet_i in range(0, len(files), per):
        batch = files[sheet_i:sheet_i + per]
        canvas = Image.new("RGB", (cols * cell_w, rows * cell_h), (16, 16, 20))
        d = ImageDraw.Draw(canvas)
        for i, name in enumerate(batch):
            im = Image.open(os.path.join(frames_dir, name)).convert("RGB")
            im.thumbnail((cell_w, cell_h), Image.LANCZOS)
            c, r = i % cols, i // cols
            canvas.paste(im, (c * cell_w, r * cell_h))
            if label:
                idx = sheet_i + i
                sec = int(start + idx * step)
                tag = "%02d:%02d" % (sec // 60, sec % 60)
                d.rectangle([c * cell_w, r * cell_h, c * cell_w + 52, r * cell_h + 15], fill=(0, 0, 0))
                d.text((c * cell_w + 3, r * cell_h + 2), tag, fill=(255, 220, 90))
        path = out if sheet_i == 0 else out.replace(".jpg", "_%02d.jpg" % (sheet_i // per + 1))
        canvas.save(path, quality=86)
        made.append({"file": path, "frames": len(batch), "size": [canvas.width, canvas.height]})
    return made


def cmd_sweep(args):
    """按区间+步长抽一批帧并拼图——对应原方法的「粗扫 / 分档加密」这一环。

    实现上逐帧 seek，而不是一次解码整个区间：B站 DASH 流对区间解码的范围
    截断不可靠（实测会退化到从头解码），逐帧定位反而稳定，每帧约 0.5 秒。
    """
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    dur = src.duration
    start = max(0.0, args.start or 0.0)
    end = min(dur, args.end) if args.end else dur
    if end <= start:
        raise SystemExit("区间为空：start=%s end=%s" % (start, end))
    step = max(1.0, args.step)
    os.makedirs(args.out, exist_ok=True)
    for f in os.listdir(args.out):
        if f.startswith("f_") and f.endswith(".jpg"):
            os.remove(os.path.join(args.out, f))

    base = [src.ff, "-hide_banner", "-loglevel", "error"]
    base += src.input_args(src.read_path)
    vf = "scale=%d:-2" % args.width
    n = 0
    at = start
    while at < end:
        dst = os.path.join(args.out, "f_%04d.jpg" % (n + 1))
        subprocess.run(base + ["-ss", "%.3f" % at, "-i", src.read_path,
                               "-frames:v", "1", "-vf", vf, "-q:v", str(args.quality),
                               "-y", dst],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.isfile(dst) and os.path.getsize(dst) > 0:
            n += 1
        at += step

    sheets = pack_images(args.out, os.path.join(args.out, "sheet.jpg"),
                         args.cols, args.rows, start, step, args.cell)
    manifest = {"ok": True, "kind": src.kind, "source": args.video,
                "start": start, "end": end, "step": step, "frames": n,
                "read_size": list(src.size), "sheets": sheets}
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "out": args.out, "frames": n,
                      "sheets": [s["file"] for s in sheets],
                      "window": [start, end], "step": step}, ensure_ascii=False))


def cmd_subtitle(args):
    """取 B站字幕：官方 CC 优先，其次 AI 字幕（ai-zh）。

    两个接口都会返回 need_login_subtitle=true 且 subtitles 为空——
    字幕是登录后才下发的，不是接口不存在。
    """
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    bvid = parse_bvid(args.spec)
    if not bvid:
        raise RuntimeError("BVID_NOT_FOUND")
    view = bili_api("/x/web-interface/view?bvid=%s" % bvid, cookie)
    if view.get("code") != 0:
        raise RuntimeError("BILI_VIEW_FAILED(%s)" % view.get("code"))
    d = view["data"]
    pages = d.get("pages") or []
    pg = pages[0]
    if args.page:
        hit = [p for p in pages if int(p.get("page", 0)) == int(args.page)]
        if hit:
            pg = hit[0]
    cid = pg["cid"]

    j = bili_api("/x/player/wbi/v2?bvid=%s&cid=%s" % (bvid, cid), cookie)
    data = j.get("data") or {}
    sub = data.get("subtitle") or {}
    subs = sub.get("subtitles") or []
    need_login = bool(data.get("need_login_subtitle") or sub.get("need_login_subtitle"))

    picked = (
        next((s for s in subs if re.match(r"^zh", str(s.get("lan", ""))) and not str(s.get("lan", "")).startswith("ai")), None)
        or next((s for s in subs if re.match(r"^ai-zh", str(s.get("lan", "")))), None)
        or next((s for s in subs if "zh" in str(s.get("lan", ""))), None)
        or (subs[0] if subs else None)
    )

    result = {
        "ok": True,
        "bvid": bvid,
        "cid": str(cid),
        "page": pg.get("page"),
        "title": d.get("title"),
        "logged_in": bool(cookie),
        "need_login_subtitle": need_login,
        "available": [{"lan": s.get("lan"), "lan_doc": s.get("lan_doc"),
                       "ai_status": s.get("ai_status")} for s in subs],
        "route": None,
        "segments": [],
    }

    if not picked:
        result["route"] = "none"
        result["reason"] = (
            "这集没有可用字幕。" + ("字幕需要登录才下发（need_login_subtitle=true），请提供 SESSDATA。" if need_login else "UP 未上传字幕，服务器也没有 AI 字幕。")
        )
        # 没有字幕也要落盘：调用方按 out 文件读取，提前返回会让它扑空
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        print(json.dumps(result, ensure_ascii=False))
        return

    url = str(picked.get("subtitle_url") or "")
    if url.startswith("//"):
        url = "https:" + url
    sj = http_json(url, cookie)
    segs = []
    for row in sj.get("body") or []:
        segs.append({
            "start": round(float(row.get("from", 0)), 2),
            "end": round(float(row.get("to", 0)), 2),
            "text": str(row.get("content", "")).strip(),
        })
    result["route"] = "ai" if str(picked.get("lan", "")).startswith("ai") else "official"
    result["lan"] = picked.get("lan")
    result["lan_doc"] = picked.get("lan_doc")
    result["segments"] = segs
    result["segment_count"] = len(segs)
    result["note"] = "机器/AI 字幕可能有错字与断句问题，专有名词需回查原片。"

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(json.dumps({"ok": True, "out": args.out, "route": result["route"],
                          "segments": len(segs)}, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False))


def _white_ratio(im):
    """白像素占比：字幕在这个区域里是白字，字越多占比越大。"""
    arr = np.asarray(im.convert("L"), dtype=np.uint8)
    return float((arr > 200).mean())


def _frame_diff(a, b, size=(160, 90)):
    """两张图缩到小尺寸后的平均绝对差，用来判断是不是同一句话。"""
    aa = np.asarray(a.convert("L").resize(size), dtype=np.int16)
    bb = np.asarray(b.convert("L").resize(size), dtype=np.int16)
    return float(np.abs(aa - bb).mean())


def _text_mask(im, thr=70):
    """文字掩码：用边缘梯度，而不是「亮像素」。

    浅色底白字的字幕（牛皮纸背景、浅灰界面）用亮度阈值会把整屏都算成文字；
    文字的特征是**强边缘**（白字带黑描边），背景是平缓的色块。
    """
    g = np.asarray(im.convert("L").resize((im.width, im.height)), dtype=np.float32)
    gy, gx = np.gradient(g)
    return np.sqrt(gx * gx + gy * gy) > thr


def _text_weight(im):
    """字量：边缘像素数。用来在组内挑「字最全」的那一帧。"""
    return float(_text_mask(im).sum())


def _contain_ratio(a, b):
    """a 里的字有多少出现在 b 里（对齐之后比较）。

    同一句的延续（补字、变亮、挪位置）→ a 的字全都还在 b 里，比值接近 1。
    换句 → 旧句的字没了，比值骤降。
    """
    total = int(a.sum())
    if total < 20:
        return 0.0
    return float(np.logical_and(a, b).sum()) / total


def _estimate_shift(a_mask, b_mask, max_shift=120):
    """用相位相关估计 b 相对 a 的位移（dy, dx）。

    用于「同一句话挪了位置」的场景：3D 游戏气泡排队滚动、招牌滑动、
    跑马灯字幕。不做对齐的话，同一句会被当成两句。
    """
    if a_mask.shape != b_mask.shape or int(a_mask.sum()) < 20 or int(b_mask.sum()) < 20:
        return 0, 0
    A = np.fft.rfft2(a_mask.astype(np.float32))
    B = np.fft.rfft2(b_mask.astype(np.float32))
    R = A * np.conj(B)
    mag = np.abs(R)
    R = R / (mag + 1e-9)
    corr = np.fft.irfft2(R, s=a_mask.shape)
    dy, dx = np.unravel_index(int(np.argmax(corr)), corr.shape)
    h, w = a_mask.shape
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w
    if abs(dx) > max_shift or abs(dy) > max_shift:
        return 0, 0
    return int(dy), int(dx)


def _shift_mask(mask, dy, dx):
    if dy == 0 and dx == 0:
        return mask
    return np.roll(np.roll(mask, dy, 0), dx, 1)


def group_caption_frames(entries, thr=0.0, blend=False):
    """把「同一句话」的连续帧归为一组，再选出最完整的一张。

    覆盖三种字幕形态，并且能处理「整句在移动」的情况：

    - **打字机**：靠前的帧只有半句，后面的帧包含前面所有字
    - **卡拉OK逐字高亮**：字位置不变、只有亮度在变
    - **移动的文字**：3D 气泡排队滚动、招牌滑过、跑马灯
      → 先用相位相关把当前帧对齐到上一帧，再比较「字还在不在」

    判据是「对齐之后，上一帧的字有多少还留在本帧」：同一句的延续接近 1，
    换句骤降。纯像素差会把亮度跳变和位移都误判成换句。

    blend=True 时对组内做亮度叠加（视觉暂留）。只在「字只增不减且位置不动」
    时成立；整句替换或持续移动的字幕叠加会叠印，必须保持关闭。
    """
    if len(entries) < 2:
        return list(entries), len(entries)

    for e in entries:
        if "mask" not in e:
            e["mask"] = _text_mask(e["img"])

    solid = [e for e in entries if int(e["mask"].sum()) >= 20]
    if len(solid) < 2:
        return list(entries), len(entries)
    entries = solid

    diffs = [_frame_diff(entries[i - 1]["img"], entries[i]["img"]) for i in range(1, len(entries))]
    auto = float(np.percentile(diffs, 60)) if diffs else 8.0
    hi = max(thr, auto, 4.0)

    groups = []
    for e in entries:
        if groups:
            prev = groups[-1][-1]
            dy, dx = _estimate_shift(prev["mask"], e["mask"])
            aligned = _shift_mask(e["mask"], dy, dx)
            keep = _contain_ratio(prev["mask"], aligned)
            e["shift"] = (dy, dx)
            # 字基本都还在（可能挪了位置）→ 同一句的延续
            if keep >= 0.85:
                groups[-1].append(e)
                continue
            d = _frame_diff(prev["img"], e["img"])
            if keep >= 0.6 and d <= hi:
                groups[-1].append(e)
                continue
        groups.append([e])

    picked = []
    for g in groups:
        # 组内挑「字最全」的那一帧：边缘像素最多 = 文字最完整
        best = max(g, key=lambda x: int(x["mask"].sum()))
        if blend and len(g) > 1:
            stack = np.maximum.reduce([np.asarray(x["img"].convert("RGB"), dtype=np.uint8) for x in g])
            best = dict(best, img=Image.fromarray(stack), blended=len(g))
        picked.append(dict(best, merged=len(g)))
    return picked, len(groups)


def cmd_caption(args):
    """按间隔抽「字幕带」并纵向拼成一张长图，一次读很多条字幕。

    字幕是横向长条，塞进 4×4 网格会被压扁；纵向堆叠能保住原始宽度，
    每条都带 mm:ss，读出来的文本可以直接拼成时间轴。
    """
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    dur = src.duration
    start = max(0.0, args.start or 0.0)
    end = min(dur, args.end) if args.end else dur
    if end <= start:
        raise SystemExit("区间为空")
    step = max(1.0, args.step)
    regions = dict(DEFAULT_REGIONS)
    if args.regions_json:
        regions = {k: tuple(v) for k, v in json.loads(args.regions_json).items()}
    box = parse_crop(args.crop) if args.crop else regions.get(args.region, DEFAULT_REGIONS["subtitle"])
    x0, y0, x1, y1 = box

    work = os.path.join(args.out, "_frames")
    os.makedirs(work, exist_ok=True)
    for f in os.listdir(work):
        if f.endswith(".jpg"):
            os.remove(os.path.join(work, f))

    w, h = src.size
    cw = max(1, int(round((x1 - x0) * w)))
    ch = max(1, int(round((y1 - y0) * h)))
    out_w = args.width
    out_h = max(1, int(round(ch * out_w / max(1, cw))))
    vf = "crop=iw*%.4f:ih*%.4f:iw*%.4f:ih*%.4f,scale=%d:%d:flags=lanczos" % (
        x1 - x0, y1 - y0, x0, y0, out_w, out_h)

    base = [src.ff, "-hide_banner", "-loglevel", "error"] + src.input_args(src.read_path)
    entries = []
    at = start
    i = 0
    while at < end:
        dst = os.path.join(work, "c_%05d.jpg" % (i + 1))
        subprocess.run(base + ["-ss", "%.3f" % at, "-i", src.read_path,
                               "-frames:v", "1", "-vf", vf, "-q:v", "3", "-y", dst],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.isfile(dst) and os.path.getsize(dst) > 0:
            im = Image.open(dst).convert("RGB")
            mask = _text_mask(im)
            entries.append({"at": at, "path": dst, "img": im,
                            "mask": mask, "white": float(mask.sum())})
            i += 1
        at += step

    total_frames = len(entries)
    if args.dedupe and entries:
        entries, group_count = group_caption_frames(entries, args.dedupe_thr, args.blend)
    else:
        group_count = total_frames

    per = max(1, args.per_sheet)
    label_w = 56
    made = []
    for s in range(0, len(entries), per):
        batch = entries[s:s + per]
        rows = len(batch)
        canvas = Image.new("RGB", (out_w + label_w, rows * (out_h + 4)), (12, 12, 16))
        d = ImageDraw.Draw(canvas)
        for j, e in enumerate(batch):
            im = e["img"]
            if im.size != (out_w, out_h):
                im = im.resize((out_w, out_h), Image.LANCZOS)
            y = j * (out_h + 4)
            canvas.paste(im, (label_w, y + 2))
            sec = int(e["at"])
            tag = "%02d:%02d" % (sec // 60, sec % 60)
            if e.get("merged", 1) > 1:
                tag += " ·%d" % e["merged"]
            d.text((3, y + 2 + out_h // 4), tag, fill=(255, 220, 90))
        path = os.path.join(args.out, "caption_%02d.jpg" % (s // per + 1))
        canvas.save(path, quality=88)
        made.append({"file": path, "lines": len(batch),
                     "window": [int(batch[0]["at"]), int(batch[-1]["at"])]})

    manifest = {"ok": True, "kind": src.kind, "source": args.video,
                "window": [start, end], "step": step, "box": [x0, y0, x1, y1],
                "frames_sampled": total_frames, "sentences": len(entries),
                "dedupe": bool(args.dedupe), "blend": bool(args.blend),
                "sheets": made}
    with open(os.path.join(args.out, "caption.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "out": args.out, "sampled": total_frames,
                      "sentences": len(entries),
                      "sheets": [m["file"] for m in made],
                      "window": [start, end], "step": step}, ensure_ascii=False))


def cmd_compose(args):
    """时间合成：把一段连续帧按某种规则合成为一张图。

    这是「识别连续动画中的可见部件」的通用做法——单帧只看得到一部分，
    时间上合起来才完整。四种模式各有各的用处：

      average / median  多帧平均或中值：压低压缩噪点，让低码率视频里的
                        小字变清楚（码率越低、噪点越重，收益越明显）
      max               取最亮：累积先后出现的亮部件（LED 字、暗底上的亮字）
      min               取最暗：累积先后出现的暗部件（亮底上的黑字）
      union             取「与背景差异最大」的像素：把运动物体扫过的地方都留下
    """
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    dur = src.duration
    start = max(0.0, args.start or 0.0)
    end = min(dur, args.end) if args.end else dur
    if end <= start:
        raise SystemExit("区间为空")
    fps = max(1.0, args.fps)

    regions = dict(DEFAULT_REGIONS)
    if args.regions_json:
        regions = {k: tuple(v) for k, v in json.loads(args.regions_json).items()}
    box = parse_crop(args.crop) if args.crop else regions.get(args.region, DEFAULT_REGIONS["full"])
    x0, y0, x1, y1 = box

    work = os.path.join(args.out, "_composition")
    os.makedirs(work, exist_ok=True)
    for f in os.listdir(work):
        if f.endswith(".jpg"):
            os.remove(os.path.join(work, f))

    w, h = src.size
    cw = max(1, int(round((x1 - x0) * w)))
    ch = max(1, int(round((y1 - y0) * h)))
    vf = "crop=iw*%.4f:ih*%.4f:iw*%.4f:ih*%.4f" % (x1 - x0, y1 - y0, x0, y0)
    if args.width and args.width < cw:
        vf += ",scale=%d:-2" % args.width

    base = [src.ff, "-hide_banner", "-loglevel", "error"] + src.input_args(src.read_path)
    # 用 -t 限制读取时长，而不是 -to：远程 DASH 流上 -to 的区间截断不可靠
    cmd = base + ["-ss", "%.3f" % start, "-i", src.read_path, "-t", "%.3f" % (end - start),
                  "-vf", "fps=%s,%s" % (fps, vf), "-q:v", "2",
                  os.path.join(work, "f_%04d.jpg")]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    files = sorted(f for f in os.listdir(work) if f.startswith("f_"))
    if not files:
        raise SystemExit("没有抽到帧")
    if len(files) > args.max_frames:
        step = len(files) / float(args.max_frames)
        files = [files[int(i * step)] for i in range(args.max_frames)]

    imgs = [np.asarray(Image.open(os.path.join(work, f)).convert("RGB"), dtype=np.int16) for f in files]

    # 时间合成只能在同一镜头里做：跨切镜头的合成会糊成一个不存在的中间态。
    # 用缩略图帧差找切点，把序列切成若干稳定段，每段单独合成。
    thumbs = [np.asarray(Image.open(os.path.join(work, f)).convert("L").resize((160, 90)), dtype=np.int16)
              for f in files]
    diffs = [float(np.abs(thumbs[i] - thumbs[i - 1]).mean()) for i in range(1, len(thumbs))]
    cut_thr = max(18.0, (float(np.percentile(diffs, 90)) * 2.5) if diffs else 18.0)
    segments, cur = [], [0]
    for i, d in enumerate(diffs, start=1):
        if d > cut_thr:
            segments.append(cur)
            cur = [i]
        else:
            cur.append(i)
    segments.append(cur)

    mode = args.mode
    made = []
    for si, seg in enumerate(segments):
        if len(seg) < args.min_frames:
            continue
        stack = np.stack([imgs[i] for i in seg])
        if mode == "average":
            out = stack.mean(axis=0)
        elif mode == "median":
            out = np.median(stack, axis=0)
        elif mode == "max":
            out = stack.max(axis=0)
        elif mode == "min":
            out = stack.min(axis=0)
        elif mode == "union":
            med = np.median(stack, axis=0)
            dev = np.abs(stack - med).sum(axis=3)
            idx = np.argmax(dev, axis=0)
            out = np.take_along_axis(stack, idx[None, :, :, None], axis=0)[0]
        else:
            raise SystemExit("unknown mode: %s" % mode)
        img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
        name = "composite.jpg" if len(segments) == 1 else "composite_%02d.jpg" % (si + 1)
        dst = os.path.join(args.out, name)
        img.save(dst, quality=92)
        made.append({"file": dst, "frames": len(seg),
                     "first_frame": (si + 1) if False else min(seg)})
        Image.fromarray(np.clip(imgs[seg[len(seg) // 2]], 0, 255).astype(np.uint8)).save(
            os.path.join(args.out, name.replace("composite", "single")), quality=92)

    if not made:
        raise SystemExit("每段都不足 %d 帧，无法合成" % args.min_frames)

    print(json.dumps({"ok": True, "mode": mode, "composites": made,
                      "segments": [len(s) for s in segments],
                      "cut_threshold": round(cut_thr, 1),
                      "note": "按镜头切分后逐段合成；single_*.jpg 是同段的一帧原样，可用于对比。"},
                     ensure_ascii=False))


def write_canonical_wav(path, pcm, rate=16000, channels=1, bits=16):
    """写一个严格的 44 字节头 WAV。

    DSH 的语音校验（validateWave）逐字段核对：fmt 块必须 16 字节、
    'data' 必须落在第 36 字节、RIFF size 必须等于文件长度减 8。
    ffmpeg 的 wav 封装会插入 LIST/INFO 块，这些偏移全对不上，
    会被判为 "Audio must be a canonical 16 kHz mono PCM16 WAV recording"。
    """
    block_align = channels * bits // 8
    byte_rate = rate * block_align
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(pcm), b"WAVE",
        b"fmt ", 16, 1, channels, rate, byte_rate, block_align, bits,
        b"data", len(pcm),
    )
    with open(path, "wb") as f:
        f.write(header)
        f.write(pcm)


def pick_segment(duration, target_count=60, lo=15.0, hi=90.0, single_below=300.0):
    """按视频总长决定切片长度（秒）。

    - 总长不超过 single_below（默认 5 分钟）时**不切**：返回总长本身，只出一段。
      短视频切开反而更慢——每段都要重新加载一次识别模型，固定开销盖过并发收益；
      本地 whisper 本来就会自己按句输出时间戳，不依赖切片。
    - 更长时按 target_count 反推每段长度并夹到 [lo, hi]：段数不爆炸、单段不过长，
      这些段随后由调用方并发转写。
    """
    try:
        duration = float(duration)
    except Exception:
        return lo
    if duration <= 0:
        return lo
    if duration <= single_below:
        return duration
    return max(lo, min(hi, duration / max(1, target_count)))


def cmd_audio(args):
    """取音轨并切成小段，供 ASR 逐段转写。

    切成段是为了给识别结果加时间戳：宿主 SpeechToText 的 Transcript 只有整段
    文本、没有时间轴，按固定长度切片后分别转写，就得到「第 N 段说了什么」。
    """
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    os.makedirs(args.out, exist_ok=True)

    src_url = src.info.get("audio_url") if src.kind == "bili" else src.read_path
    if not src_url:
        raise RuntimeError("NO_AUDIO_TRACK: 这集没有单独的音轨（或不是 B站源）")

    audio_path = os.path.join(args.out, "audio.m4a")
    base = [src.ff, "-hide_banner", "-loglevel", "error"] + src.input_args(src_url)
    ok = False
    err_tail = b""
    if not (os.path.isfile(audio_path) and os.path.getsize(audio_path) > 65536):
        subprocess.run(base + ["-i", src_url, "-vn", "-c:a", "copy", "-y", audio_path],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok = os.path.isfile(audio_path) and os.path.getsize(audio_path) > 65536
        if not ok:
            # 有些音轨是 opus/ec3，直接转 aac
            p = subprocess.run(base + ["-i", src_url, "-vn", "-c:a", "aac", "-b:a", "96k",
                                       "-y", audio_path],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            err_tail = p.stderr or b""
            ok = os.path.isfile(audio_path) and os.path.getsize(audio_path) > 65536
    else:
        ok = True
    if not ok:
        err = err_tail.decode("utf-8", "ignore").strip()
        # 源本身没有音轨时 ffmpeg 报「输出文件不含任何流」——这和下载失败是两件事
        if "does not contain any stream" in err:
            raise RuntimeError(
                "NO_AUDIO_TRACK: 这个源没有音轨 —— 画面正常，但没有可转写的声音。"
            )
        raise RuntimeError("AUDIO_DOWNLOAD_FAILED: " + (err[-300:] or "ffmpeg 未能提取音轨"))

    for f in os.listdir(args.out):
        if f.startswith("seg_") and f.endswith(".wav"):
            os.remove(os.path.join(args.out, f))

    dur = duration_of(src.ff, audio_path)
    # --segment 0（默认）表示自适应：切片长度由总长决定；显式给正值则完全按调用方来。
    seg = pick_segment(dur) if not args.segment or args.segment <= 0 else max(5.0, args.segment)

    # 先转成裸 PCM，再自己拼标准 44 字节 WAV 头。
    # ffmpeg 的 wav 封装会插入 LIST/INFO 块，导致 'data' 偏移不是 36、
    # RIFF size 也不等于长度减 8，DSH 的 validateWave 会直接拒收。
    pcm_path = os.path.join(args.out, "audio.pcm")
    subprocess.run([src.ff, "-hide_banner", "-loglevel", "error", "-i", audio_path,
                    "-ar", str(args.rate), "-ac", "1", "-f", "s16le", "-y", pcm_path],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (os.path.isfile(pcm_path) and os.path.getsize(pcm_path) > 1024):
        raise RuntimeError("AUDIO_DECODE_FAILED")
    with open(pcm_path, "rb") as fh:
        pcm_all = fh.read()

    bytes_per_sec = args.rate * 2          # 16 kHz × 16 bit × 单声道
    step = int(seg * bytes_per_sec)
    segments = []
    idx = 0
    for off in range(0, len(pcm_all), step):
        chunk = pcm_all[off:off + step]
        if len(chunk) < 1600:              # 尾巴太短就丢掉
            break
        if len(chunk) % 2:                 # PCM16 必须是偶数长度
            chunk = chunk[:-1]
        p = os.path.join(args.out, "seg_%04d.wav" % idx)
        write_canonical_wav(p, chunk, args.rate)
        segments.append({
            "index": idx,
            "start": round(idx * seg, 2),
            "end": round(min(dur, (idx + 1) * seg), 2),
            "file": p,
            "bytes": os.path.getsize(p),
        })
        idx += 1
    manifest = {"ok": True, "kind": src.kind, "source": args.video,
                "audio": audio_path, "duration": round(dur, 2),
                "segment_seconds": seg, "sample_rate": args.rate,
                "segments": segments}
    with open(os.path.join(args.out, "audio.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "out": args.out, "audio": audio_path,
                      "duration": round(dur, 2), "segments": len(segments),
                      "segment_seconds": seg}, ensure_ascii=False))


def cmd_setup_asr(args):
    """把 faster-whisper 装到独立目录（不污染系统 Python）。

    执行环境对 shell 有文件沙箱，但插件自己起的子进程有完整权限，
    所以 pip 的临时文件写入放在这里能过。
    """
    target = os.path.abspath(args.target)
    os.makedirs(target, exist_ok=True)
    tmp = os.path.join(os.path.dirname(target), "_piptmp")
    os.makedirs(tmp, exist_ok=True)
    env = dict(os.environ)
    env.update({"TMP": tmp, "TEMP": tmp, "TMPDIR": tmp, "PIP_NO_CACHE_DIR": "1"})

    cmd = [sys.executable, "-m", "pip", "install", "--target", target, "--upgrade",
           "--only-binary=:all:", "faster-whisper"]

    if getattr(args, "detach", False):
        # 后台安装：装 200MB 依赖要好几分钟，同步等待容易被会话中断打断。
        log = os.path.join(os.path.dirname(target), "setup.log")
        fh = open(log, "wb")
        flags = 0
        if os.name == "nt":
            flags = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        p = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT, env=env,
                             creationflags=flags, cwd=os.path.dirname(target) or None)
        print(json.dumps({"ok": True, "detached": True, "pid": p.pid,
                          "log": log, "target": target}, ensure_ascii=False))
        return

    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=1800, env=env, cwd=os.path.dirname(target) or None)
    tail = r.stdout.decode("utf-8", "ignore")[-3000:]

    ok = r.returncode == 0
    check = ""
    if ok:
        r2 = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, %r); from faster_whisper import WhisperModel; "
             "import ctranslate2; print('faster_whisper ok', ctranslate2.__version__)" % target],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300, env=env)
        check = r2.stdout.decode("utf-8", "ignore")[-800:]
        ok = r2.returncode == 0 and "ok" in check
    print(json.dumps({"ok": ok, "target": target, "exit": r.returncode,
                      "check": check.strip(), "tail": tail[-1200:]}, ensure_ascii=False))


def cmd_fetch(args):
    """把在线源转封装成本地 mp4，之后所有操作可离线复用（只下一次）。

    取的是「读取轨」（最高可用清晰度）；需要低清版可传 --track scan。
    """
    cookie = args.cookie or os.environ.get("BILI_SESSDATA", "")
    src = Source(args.video, cookie, args.page, args.ffmpeg)
    os.makedirs(args.out_dir, exist_ok=True)
    name = args.name or "source.mp4"
    dst = os.path.join(args.out_dir, name)
    if os.path.isfile(dst) and os.path.getsize(dst) > 1024:
        print(json.dumps({"ok": True, "out": dst, "reused": True,
                          "bytes": os.path.getsize(dst)}, ensure_ascii=False))
        return
    url = src.scan_path if args.track == "scan" else src.read_path
    cmd = [src.ff, "-hide_banner", "-loglevel", "error"]
    cmd += src.input_args(url)
    cmd += ["-i", url, "-c", "copy", "-y", dst]
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if not os.path.isfile(dst) or os.path.getsize(dst) < 1024:
        raise RuntimeError("FETCH_FAILED: %s" % r.stderr.decode("utf-8", "ignore")[-400:])
    print(json.dumps({"ok": True, "out": dst, "reused": False,
                      "bytes": os.path.getsize(dst),
                      "track": args.track}, ensure_ascii=False))


def cmd_sheet(args):
    files = sorted(f for f in os.listdir(args.dir)
                   if f.lower().endswith((".jpg", ".png")) and not f.startswith(args.out))
    if args.filter:
        files = [f for f in files if args.filter in f]
    if not files:
        raise SystemExit("no images in %s" % args.dir)
    imgs = [Image.open(os.path.join(args.dir, f)).convert("RGB") for f in files]
    cols = max(1, args.cols)
    cw = max(i.width for i in imgs)
    ch = max(i.height for i in imgs)
    rows = (len(imgs) + cols - 1) // cols
    label_h = 14 if args.label else 0
    canvas = Image.new("RGB", (cols * cw, rows * (ch + label_h)), (16, 16, 20))
    d = ImageDraw.Draw(canvas)
    for i, (im, name) in enumerate(zip(imgs, files)):
        c, r = i % cols, i // cols
        canvas.paste(im, (c * cw, r * (ch + label_h) + label_h))
        if args.label:
            d.text((c * cw + 3, r * (ch + label_h) + 2), name[:60], fill=(255, 220, 90))
    if args.maxwidth and canvas.width > args.maxwidth:
        ratio = args.maxwidth / canvas.width
        canvas = canvas.resize((args.maxwidth, max(1, int(canvas.height * ratio))), Image.LANCZOS)
    canvas.save(args.out, quality=args.quality)
    print(json.dumps({"ok": True, "out": args.out, "images": len(files),
                      "size": [canvas.width, canvas.height]}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ffmpeg", default="", help="显式 ffmpeg 路径")
    ap.add_argument("--cookie", default="", help="B站 Cookie（SESSDATA=...）；默认读环境变量 BILI_SESSDATA")
    ap.add_argument("--page", type=int, default=None, help="B站分P序号，从 1 开始")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("resolve")
    r.add_argument("spec")

    p = sub.add_parser("probe")
    p.add_argument("video")

    s = sub.add_parser("scan")
    s.add_argument("video")
    s.add_argument("--out")
    s.add_argument("--fps", type=float, default=1.0)
    s.add_argument("--width", type=int, default=384)
    s.add_argument("--height", type=int, default=216)
    s.add_argument("--top", type=int, default=60)
    s.add_argument("--bucket", type=int, default=300, help="密度分档区间长度（秒），默认 300")
    s.add_argument("--regions-json", default="")

    g = sub.add_parser("grab")
    g.add_argument("video")
    g.add_argument("--at", required=True)
    g.add_argument("--regions", default="panel,status")
    g.add_argument("--crop", default="", help="自定义区域：x0,y0,x1,y1（相对坐标）")
    g.add_argument("--out", required=True)
    g.add_argument("--scale", type=float, default=3.0)
    g.add_argument("--quality", type=int, default=88)
    g.add_argument("--regions-json", default="")
    g.add_argument("--reuse", action="store_true", help="已存在的同刻同区域帧直接复用")

    sw = sub.add_parser("sweep")
    sw.add_argument("video")
    sw.add_argument("--start", type=float, default=0)
    sw.add_argument("--end", type=float, default=0)
    sw.add_argument("--step", type=float, default=60)
    sw.add_argument("--width", type=int, default=480)
    sw.add_argument("--cols", type=int, default=4)
    sw.add_argument("--rows", type=int, default=4)
    sw.add_argument("--cell", type=int, default=400)
    sw.add_argument("--quality", type=int, default=4)
    sw.add_argument("--out", required=True)

    co = sub.add_parser("compose")
    co.add_argument("video")
    co.add_argument("--start", type=float, default=0)
    co.add_argument("--end", type=float, default=0)
    co.add_argument("--fps", type=float, default=10)
    co.add_argument("--mode", default="median",
                    choices=["average", "median", "max", "min", "union"])
    co.add_argument("--crop", default="")
    co.add_argument("--region", default="full")
    co.add_argument("--width", type=int, default=0)
    co.add_argument("--max-frames", type=int, default=40)
    co.add_argument("--min-frames", type=int, default=3, help="每段至少几帧才合成，默认 3")
    co.add_argument("--out", required=True)
    co.add_argument("--regions-json", default="")

    ca = sub.add_parser("caption")
    ca.add_argument("video")
    ca.add_argument("--start", type=float, default=0)
    ca.add_argument("--end", type=float, default=0)
    ca.add_argument("--step", type=float, default=5)
    ca.add_argument("--region", default="subtitle")
    ca.add_argument("--crop", default="")
    ca.add_argument("--width", type=int, default=720)
    ca.add_argument("--per-sheet", type=int, default=10)
    ca.add_argument("--dedupe", action="store_true", default=True,
                    help="同一句话的多帧合并成一组，取字最多的那张（默认开）")
    ca.add_argument("--no-dedupe", dest="dedupe", action="store_false")
    ca.add_argument("--dedupe-thr", type=float, default=0.0,
                    help="强制分句阈值；0 表示按该视频相邻帧差自适应")
    ca.add_argument("--blend", action="store_true",
                    help="组内做亮度叠加（视觉暂留），适合新旧字幕交替覆盖、单帧只显示一部分的情况")
    ca.add_argument("--out", required=True)
    ca.add_argument("--regions-json", default="")

    su = sub.add_parser("subtitle")
    su.add_argument("spec")
    su.add_argument("--out", default="")

    st_ = sub.add_parser("setup-asr")
    st_.add_argument("--target", required=True)
    st_.add_argument("--detach", action="store_true", help="后台安装，立即返回 pid")

    au = sub.add_parser("audio")
    au.add_argument("video")
    au.add_argument("--segment", type=float, default=0,
                    help="切片长度（秒）；0（默认）= 按视频总长自适应")
    au.add_argument("--rate", type=int, default=16000)
    au.add_argument("--out", required=True)

    fe = sub.add_parser("fetch")
    fe.add_argument("video")
    fe.add_argument("--out-dir", required=True)
    fe.add_argument("--name", default="source.mp4")
    fe.add_argument("--track", choices=["read", "scan"], default="read")

    sh = sub.add_parser("sheet")
    sh.add_argument("dir")
    sh.add_argument("--out", required=True)
    sh.add_argument("--cols", type=int, default=1)
    sh.add_argument("--filter", default="")
    sh.add_argument("--label", action="store_true")
    sh.add_argument("--maxwidth", type=int, default=0)
    sh.add_argument("--quality", type=int, default=88)

    args = ap.parse_args()
    {"resolve": cmd_resolve, "scan": cmd_scan, "grab": cmd_grab, "fetch": cmd_fetch,
     "audio": cmd_audio, "setup-asr": cmd_setup_asr, "subtitle": cmd_subtitle,
     "caption": cmd_caption, "compose": cmd_compose, "sweep": cmd_sweep,
     "sheet": cmd_sheet, "probe": cmd_probe}[args.cmd](args)


if __name__ == "__main__":
    main()
