# 变更记录

## 0.9.1 — 2026-10-24

### 新增

- **`video_outline` 并行接入音频转写**：新增 `withAsr`（默认 `true`）与 `asrSegment`。`sections` 里每段多了 `asr` 字段，与 `subtitle` 并列。
- **ASR 切片自适应**：`--segment 0`（默认）由视频总长决定 —— **不超过 5 分钟不切**，整段一次读完（每段都要重新加载一次识别模型，切开反而更慢；本地 whisper 本来就会自己按句输出时间戳）；**更长才切片并并发**，每段 `clamp(总长 / 60, 15, 90)` 秒。实测 90s → 1 段，400s → 15s × 27 段，724s → 15s × 49 段，3600s → 60s × 61 段，7200s → 90s × 81 段。
- **多段并发转写**：每段独立文件、独立进程，默认 3 路并发（`concurrency` 可调，上限 8）。结果按时间排序后合成 `text` 全文与 `segments` 时间戳分段一起返回。
- 抽出内部函数 `doAsrCore`（返回全量分段）与 `doAsr`（分页包装）；`video_asr` 改为调用它们，对外行为不变。

### 修复

- **无音轨被误报成下载失败**：源本身没有音轨时 `cmd_audio` 一律抛 `AUDIO_DOWNLOAD_FAILED`，看起来像网络问题。现在读取 ffmpeg 的 stderr 加以区分，报 `NO_AUDIO_TRACK: 这个源没有音轨 —— 画面正常，但没有可转写的声音。`
- **缺 ffmpeg 时全部工具一起失效，且报错不可操作**：`find_ffmpeg` 的三条定位路径（显式参数 / `imageio_ffmpeg` / PATH）任一满足即可，但三者皆空时 probe / scan / fetch / frames / caption / compose / asr 全部在 `Source.__init__` 处统一失败，只抛一句 `FFMPEG_NOT_FOUND`，看不出该装什么、装到哪个解释器。现在错误信息直接给出可复制的 pip 命令，并带上当前解释器的绝对路径。

### 变更

- **`video_outline` 从「扫描 → 抽帧 → 取字幕」全串行改为三路并行**。以阅读画面为主线：只有扫描失败才算整体失败，字幕与 ASR 各自兜住异常，缺一条只是少一个证据源。总耗时约等于 `max(扫描 + 抽帧, 字幕, 转写)`，而不是三者相加。输出新增 `asr_route` / `asr_segment_count`，辅助通道失败时带 `asr_reason`。
- `video_outline` 的描述改为「画面是主证据，字幕与音频转写是并列的辅助源」，调用方不必再自己串一遍 `video_asr` 做交叉核对。
- **运行时不再自动 `pip install`**。发行版插件不应擅自改动用户环境：此前缺口时引擎会静默向当前解释器装依赖，行为不可预期、也绕过包管理。改为
  - 启动时 `apply()` 做一次非阻塞自检，缺失只记一条带安装命令的警告；
  - 确需代为补装时，在 profile 的 `cordis.patch.yml` 里显式设置 `autoInstallFfmpeg: true`。
- `find_ffmpeg` 去掉供应商目录查找与安装重试，只做「探测 + 报错」，判定顺序仍为 `imageio_ffmpeg` → PATH。

### 发行

- `package.json` 补全 `author` / `repository` / `homepage` / `bugs` / `engines` / `publishConfig`，移除 `private`，`exports` 补 `./cordis.patch.yml` 与 `./package.json`，`files` 补 `LICENSE`。
- README 增「装 ffmpeg」小节，写清推荐安装方式与 `autoInstallFfmpeg` 开关。

### 取舍

- 默认开启 ASR 会让长视频上的 `video_outline` 变慢（转写本身耗时）；不需要时传 `withAsr: false` 退回「只读画面 + B站字幕」。

## 0.9.0 — 2026-10-23

从「按界面事件抽帧」扩展到「视频解读全流程」。这一版的判断是：**看懂视频要分通道，每种通道都有自己的失效条件，工具必须诚实地说出来**。

### 新增

- **`video_outline`**：把扫描结果整备成文证据——按密度段聚合「时间轴 + 事件 + 关键帧 + 字幕」，返回可直接填进文档的结构。帧数按段长自适应（2 帧起步，每 3 分钟加 1 帧，最多 6 帧）。
- **`templates/TUTORIAL_DOC.md`**：方法流程文档模板。每个步骤 = 目的 / 前置 / 步骤 / 检查点 / 常见错误；数值当起点不当验收；不确定处显式标「待核验」。
- **`video_asr`**：音频转写，双后端。宿主 SenseVoice（VAD 静音切分）优先，本地 whisper.cpp（CPU）兜底，都没有时返回切好的音频让别人转。
- **`video_caption`**：硬字幕纵向长图，处理三种形态——打字机（取字最全的帧）、卡拉OK（取全高亮帧）、移动气泡（`dedupe:false` 直接保留全部）。
- **`video_sweep`**：分档抽帧拼图，4×4 带时间标。
- **`video_compose`**：时间合成，5 种模式。

### 变更

- 扫描先判 `content_mode`：有长期静止界面框架 → `operation`（软件操作），否则按 `scene_cuts` 判 `slides`（讲解/剪辑）。两种类型走不同采样策略。
- `slides` 模式下事件类型统一记为 `scene`，避免输出一堆误导性的 `menu`；`video_outline` 改按整屏切换点分段，一页一帧。
- `video_asr` 的降级链完整化：宿主 SenseVoice → 本地 whisper.cpp → `no_backend`（附音频路径与说明）。

### 修复

- **`-osrt` 写文件不可靠**：whisper-cli 在受限目录下静默失败（退出码仍是 0）。改为解析它打印到 stdout 的 `[hh:mm:ss.mmm --> hh:mm:ss.mmm] 文本` 行。
- **WAV 头不合规**：DSH 的 `validateWave` 逐字段核对，要求 `data` 精确落在第 36 字节、RIFF size 等于长度减 8。ffmpeg 的 wav 带 LIST 块，直接判 "Invalid speech WAV"。改为从裸 PCM 自己拼 44 字节头。
- **SenseVoice 不激活**：插件 `inject = ["speechToText", "subprocess"]`，缺 `subprocess` 时整个插件被跳过——重启多少次都没用。profile 里 insert `@deepseek-ai/dsh-subprocess-local` 解决。
- **VAD 路径错误**：`silero_vad.onnx` 必须放在 `<dataRoot>/models/silero/`，和模型放一起会校验失败。
- **远程 sweep 卡死**：`-to` 作输入选项对远程流不可靠，改为逐帧 `-ss` 定位。
- **跨镜头合成糊成中间态**：用缩略图帧差切分，确保只合成同一镜头内的帧。

### 实测结论（写进限制，免得再试）

- **480p 是硬上限**：未登录只能拿 480p，UI 文字 6–8 px，参数数值读不准——像素里就没有，超分救不回。
- **`union` / `average` 对整句替换的字幕无效**：新旧句叠成重影。视觉暂留只在「字只增不减」时成立，要读整句请用 `video_caption` 取最全帧。
- **卡拉OK字幕不要叠加**：会两句叠印，与 `union` 同类问题。
- **等间隔抽帧不可靠**：实测 33% 的画面变化离最近采样点 ≥20 秒。

## 0.1.0

初版：按界面事件抽帧 + UI 区域高分辨率裁切，目标是让视频里的菜单和状态可读。
