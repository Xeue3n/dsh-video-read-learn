# 变更记录

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
