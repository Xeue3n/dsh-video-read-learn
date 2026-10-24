# dsh-video-read-learn · 视频精读

**画面 · 字幕 · 音频** ｜ 三条信息通道

> **在线源目前仅支持哔哩哔哩（B站）。**
> 本地视频文件可以直接分析；但网页链接只解析 B站——YouTube、抖音、其他站点的链接现在都不支持，
> 传进去会直接报错而不是猜着解析。

输入是 **B站分享链接 / BV 号 / 本地文件**，输出是「这一集讲了什么、做了什么」，以及可以拿去填的方法流程文档骨架。

**直链不用你爬**：插件自己调 `playurl` 接口解析，并按需从流里取帧，不下载整段视频。

三条信息通道各自有明确的适用面：

| 通道 | 何时用 | 工具 |
|---|---|---|
| **画面** | 教程操作、界面切换 | `video_scan` / `video_sweep` / `video_frames` |
| **硬字幕** | 解说烧进了画面 | `video_caption` |
| **音频** | 画面里一个字都没有 | `video_asr` |

## 安装

插件以 bundle 形式装进 DSH 的 profile，`install_bundle` 收的是**本地目录的绝对路径**——所以先把代码拿到本地，再把它装进去。

### 依赖

| 项 | 必需 | 说明 |
|---|---|---|
| DSH `>=0.2.1-rc.2 <0.3.0` | ✅ | 插件入口与 patch 格式依赖它 |
| Python 3.10+ 带 `numpy` + `Pillow` | ✅ | 自动探测 DSH runtime 自带的 Python |
| ffmpeg | ✅ | 优先用 `imageio_ffmpeg` 附带的，见下「装 ffmpeg」 |
| 宿主 SenseVoice | ⬜ | 没有就退化到本地 whisper.cpp，见「音频转写」 |
| 本地 whisper.cpp | ⬜ | 放在 `~/.dsh/video-read/whisper/` |

### 获取代码

两种方式任选：

**方式一：git clone**（想用 `git pull` 更新就选这个）

```powershell
git clone https://github.com/Xeue3n/dsh-video-read-learn.git
```

**方式二：下载 Release 附件**

到 [Releases](https://github.com/Xeue3n/dsh-video-read-learn/releases) 下载 `dsh-video-read-learn-<版本>.zip`，解压到任意目录。

### 装进 DSH

把上一步得到的目录（**绝对路径**）交给 `plugin_manager`：

```text
plugin_manager  action: install_bundle  target: <目录的绝对路径>
```

例如：

```text
plugin_manager  action: install_bundle  target: C:\Users\me\plugins\dsh-video-read-learn
```

返回 `application: applied` 即装好，`video_*` 工具随即可用。该操作会改动 profile，装之前 DSH 会让你确认一次。

### 更新

```powershell
cd dsh-video-read-learn
git pull
```

然后对同一个目录再 **remove → install** 一次（`index.js` 不走热加载）：

```text
plugin_manager  action: remove_bundle   target: dsh-video-read-learn
plugin_manager  action: install_bundle  target: <目录的绝对路径>
```

`scripts/video_engine.py` 与 `templates/*.md` 每次从磁盘现读，改完直接生效，不用重装。

### 本地开发

| 改了哪个文件 | 要做什么 |
|---|---|
| `index.js` | 必须 remove + install 才生效 |
| `scripts/video_engine.py` | 直接生效，不用重装 |
| `templates/*.md` | 直接生效 |

数据目录：

```text
<workDir>/                     默认 ~/.dsh/video-read
├─ <video-tag>/
│  ├─ events_f1_t24_p1.json    扫描结果缓存（同参数复用）
│  ├─ grab_s3_*/               帧缓存（同刻同区复用）
│  ├─ audio/                   audio.m4a、seg_*.wav、asr.json
│  ├─ sweep_*/                 分档拼图
│  └─ caption_*/               字幕长图
└─ whisper/                    可选：whispercpp/ + models/ggml-small.bin
```

`workDir`、`whisperDir`、`pythonPath`、`cookieFile` 都能在插件配置里覆盖。

## 教程类视频：输出方法流程文档

`video_outline` 负责**整备证据**，不写笔记：

```
video_outline { video: "BV1xxxxxxxxx" }
```

返回按密度段聚合的结构：

```json
{ "index": 7, "start": 2700, "end": 4500, "level": "high",
  "frames": ["…/full_02957.0.jpg", "…/full_04243.0.jpg", "6 张"],
  "events": [{ "at": 2874, "kind": "menu", "span": [2874, 2947] }],
  "subtitle": null }
```

帧数按段长自适应：2 帧起步，每 3 分钟加 1 帧，最多 6 帧。79 分钟实测 8 段 26 帧。

配套模板：`templates/TUTORIAL_DOC.md`，结构取自真实项目的手册格式：

```text
每个步骤 = 目的 / 前置 / 步骤(编号) / 检查点 / 常见错误
数值     = 起点，不是验收标准
不确定处 = 显式标「待核验」
画面与解说 = 两种证据，分开标注
```

## 操作序列，不是帧清单

```
video_scan { video: "BV1xxxxxxxxx", top: 24 }
```

每个事件带一个 `kind`，由「哪几个区域同时变了」推断：

| kind | 触发条件 | 意味着 |
|---|---|---|
| `menu` | 顶部菜单栏变了 | 打开菜单找命令 |
| `object` | 大纲 + 属性面板同时变 | 新建 / 切换 / 删除物体 |
| `params` | 只有属性面板变 | 加修改器或调参数 |
| `scene` | 只有大纲变 | 层级、命名、可见性 |
| `view` | 只有画面变 | 换视图 / 转镜头 / 看整体 |

实测一集 79 分钟的建模教程：

```text
t=  14  menu    span=[14,76]        开场找菜单
t= 871  object  span=[871,878]      开始建形
t= 898  object  span=[898,917]
t=1267  object  span=[1256,1279]
t=2824  object  span=[2815,2834]    形体告一段落
t=2874  menu    span=[2874,2947]    转入另一套操作（材质/绑定）
t=3612  menu    span=[3610,3785]
```

看得出「前 30 分钟在堆形体、后 40 分钟在频繁开菜单」——这就是流程骨架。具体某一步做了什么，再对那个时刻抽 `full` 或 `panel` 图看即可。

## 为什么不用下载整段

B站 DASH 里每个清晰度是一条独立的 m4s 流。ffmpeg 带 `Referer` 对 HTTP 做 `-ss` 定位时，只请求目标秒附近的字节区间。

扫描必须连续解码才有时间轴，所以走**最低清晰度**轨（79 分钟 73 秒、不落盘）；抽帧才走**最高可用**轨（每帧 0.4–0.6 秒）。

## 硬字幕：从画面里读，不靠接口

`video_caption` 按间隔抽「字幕带」，**纵向**拼成长图（字幕是横条，塞进 4×4 网格会被压扁），
每条带 `mm:ss`，读下来就是这一段的旁白/对话全文。

```
video_caption { video, start: 100, end: 160, step: 3, crop: "0.02,0.60,0.98,0.95" }
```

两条处理打字动画的机制（默认开启第一条）：

| 机制 | 做法 | 适用 |
|---|---|---|
| **取最全帧**（默认） | 相邻帧按「上一帧的字有多少还留在本帧」分句，组内取边缘像素最多的那张 | 打字机、卡拉OK逐字高亮、整句替换——三种都能处理 |
| **帧叠加**（`blend:true`） | 对合并组做亮度最大值叠加 | **只在「字只增不减」时成立**：同一句被拆成前后两半、或新旧字幕交替覆盖 |

时间标签旁的 `·N` 表示这一条合并了几帧。

### 为什么默认不开叠加

拿一个卡拉OK逐字高亮的科普视频（`BV1xxxxxxxxx`）实测过：

- **叠加**：把相邻两句叠印在一起（“究其原理 想必大家都已经知道” + “我们同样能看到连续的小动画”糊成一团）——因为换句时新句子落在同一位置，亮度叠加等于两次曝光
- **取最全帧**：每句都拿到「全高亮」的那一帧，干净可读

字幕形态有三种，靠叠加一条路吃不下：

| 形态 | 特征 | 正确做法 |
|---|---|---|
| 打字机 | 字逐个增加，后面的帧包含前面 | 取最后/最全的一帧 |
| 卡拉OK逐字高亮 | 整句先暗后亮，字位置不变 | 取全高亮的那一帧 |
| 整句替换 | 旧句消失、新句出现 | 两句分开，**绝不能叠** |

所以 `blend` 是给极端情况留的开关，不是默认路径。

### 分句判据为什么用「字还在不在」

早期用像素差 + 白像素占比，两个坑都踩过：

- **像素差**：卡拉OK整句先暗后亮，亮度跳变被误判成换句（同一句被切成两条）
- **白像素**：浅色底白字的字幕（牛皮纸背景、浅灰界面），`亮度 > 200` 把背景也算成字，掩码几乎是整屏

现在用**边缘梯度**做文字掩码（文字特征是强边缘，背景是平缓色块），再用「上一帧的字有多少还留在本帧」判断是否同一句——同一句的延续接近 1，换句骤降。

**已知局限**：分句仍可能把一句拆成两条（说话人切换、角色立绘跳动都会干扰）。

## 音频转写：无字幕视频的唯一通道

画面里没字、又没有 CC 字幕时，只能靠听。`video_asr` 把音轨抽出来、切片、转写，输出带时间戳的分段：

```
video_asr { video: "BV1xxxxxxxxx" }
```

两级后端，自动择优：

| 后端 | 条件 | 特点 |
|---|---|---|
| **宿主 SenseVoice** | `cordis.patch.yml` 配好 `speech-to-text` + `speech-to-text-sensevoice`，且模型下载完成 | 按静音切分（VAD），不占插件代码 |
| **本地 whisper.cpp** | `<whisperDir>/whispercpp/Release/whisper-cli.exe` + `models/ggml-small.bin` | 离线、纯 CPU、30 秒音频约 16 秒 |

宿主两个插件的必填项：`speech-to-text` 要 `defaultProvider`，`speech-to-text-sensevoice` 要 `dataRoot`。
缺任何一个，provider 都不会注册，调用方只会看到 "Prepare the local speech provider before recording"。

**要启用它，得改 profile 的 `cordis.patch.yml`（不在本包内）**：

```yaml
- insert:
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'   # sensevoice 的 inject 依赖它

- id: speech-to-text
  name: '@deepseek-ai/dsh-experimental-speech-to-text'
  config:
    defaultProvider: sensevoice-local
    language: zh

- id: speech-to-text-sensevoice
  name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
  config:
    providerId: sensevoice-local
    dataRoot: 'C:\Users\<you>\.dsh\speech-to-text'
```

改完重启 DSH。模型可以等它自己下（`modelOrigins` 已含 hf-mirror），也可以按下面结构预置——
**注意 VAD 在独立目录**，和模型放一起会校验失败：

```text
<dataRoot>/models/sensevoice-onnx/model.int8.onnx    228 MB
<dataRoot>/models/sensevoice-onnx/tokens.txt         308 KB
<dataRoot>/models/silero/silero_vad.onnx             1.7 MB
```

三个文件的地址与 sha256 在 `runtime/assets.json` 里。

两个实现细节：

- **不依赖 `-osrt` 写文件**：whisper-cli 把 `.srt` 写在输入文件旁边，在受限目录下会静默失败（退出码仍是 0）。
  现在直接解析它打印到 stdout 的 `[hh:mm:ss.mmm --> hh:mm:ss.mmm] 文本` 行。
- **硬切片的代价**：按 30 秒机械切片，段交界处会有半句重叠（例如 `00:29–00:31` 与 `00:30–00:33`）。
  宿主 SenseVoice 用 VAD 按静音切，正好避开这个问题。

## 两种视频，两套采样策略

`video_scan` 会先判 `content_mode`。判据不是「UI 区域有没有变化」（任何有文字和图形的视频都会变），
而是**有没有长期静止的界面框架**——软件界面有边框和底色长期不动，讲解视频的固定区域里是角色、字幕和截图。

| 判据 | 结论 | 策略 |
|---|---|---|
| `ui_static_p50 < 0.5` 且 UI 事件率 ≥ 3% | `operation` 软件操作演示 | 按 `coverage_plan` 分档抽帧 |
| 有 ≥8 次整屏切换 | `slides` 讲解/剪辑 | 按 `scene_cuts` 每次切换取一张 `full` |
| 都不满足 | `mixed` | 先粗扫确定内容形态 |

两个实测样本：

| | 建模教程（`BV1xxxxxxxxx`） | 评测讲解（`BV1yyyyyyyyy`） |
|---|---|---|
| 判为 | `operation`（ui_static_p50=0.059） | `slides`（ui_static_p50=0.98） |
| 时长 | 79 分钟 | 22 分钟 |
| 采样 | 分三档 → **182 帧** | 按切换点 → **14 帧** |
| 依据 | 后 30 分钟全是菜单操作，需加密 | 12 道题各一张判决页，14 帧读完 |

**如果用错策略**：给讲解视频套密度网格，会抽到大量「同一角色立绘静止」的重复帧；
给操作演示套切换点，会漏掉缓慢推进的建模步骤。

## 三档采样：粗扫 → 分档加密 → 关键点精读

`video_scan` 现在输出两份互补的东西：

| 输出 | 作用 |
|---|---|
| `density.buckets` + `coverage_plan` | **连续覆盖的主干**：把时间切成 5 分钟区间，按加权变化量分 low/mid/high，每档给建议步长（low=90 / mid=35 / high=15）与预计帧数 |
| `suggested` | **档内尖峰**：最值得单看的时刻，带 `kind`（menu/object/params/scene/view）与 `span` |

实测一集 79 分钟（BV1xxxxxxxxx）：

```text
  0- 300s mid  step=35   →  9 帧
300- 900s low  step=90   →  7 帧
900-1500s mid  step=35   → 18 帧
1500-1800s low step=90   →  4 帧
1800-2100s mid step=35   →  9 帧
2100-2700s low step=90   →  7 帧
2700-4500s high step=15  → 120 帧   ← 后 30 分钟最密
4500-4758s mid step=35   →  8 帧
合计约 182 帧
```

然后按计划分段调 `video_sweep`，一张 4×4 拼图看 16 帧：

```
video_sweep { video, start: 0, end: 240, step: 15 }   →  1 张拼图
```

拼图里每格带 `mm:ss` 标签。240 秒 × step=15 正好 16 帧一张——**一段一段地看流程，而不是一帧一帧地猜**。

真正需要细节的格子，再 `video_frames` 对那一刻做原分辨率裁切。

> 为什么要两档而不是一档：事件是「点」，密度是「区间」。只抓事件会漏掉缓慢推进的段落；只按密度均匀抽又会错过短暂但关键的突变。两者叠起来才完整。

## 工具

| 工具 | 通道 | 作用 |
|---|---|---|
| `video_probe` | 源 | 时长、清晰度、登录状态、可读性判定 |
| `video_scan` | 画面 | **主干**：密度分档 + 采样计划 + 事件表 + 内容形态判定 |
| `video_sweep` | 画面 | **分档抽帧**：区间 + 步长 → 拼图（4×4，带时间标签） |
| `video_frames` | 画面 | 精调：指定时刻 / 区域 / `crop`，原分辨率裁切 |
| `video_digest` | 画面 | 一键：扫描 + 挑关键时刻 + 抽图 |
| `video_caption` | 字幕 | 硬字幕纵向长图，自动分句取最全帧 |
| `video_subtitle` | 字幕 | B站 CC / AI 字幕（需登录） |
| `video_asr` | 音频 | 音频转写（SenseVoice → whisper.cpp 降级） |
| `video_outline` | 输出 | 整备成文证据 + 给方法流程文档模板 |
| `video_fetch` | 底座 | 落本地、断网复用 |
| `video_compose` | 底座 | 时间合成（仅 `median` 可用，见限制） |

### 区域

| 名称 | 位置 | 读什么 |
|---|---|---|
| `full` | 整帧 | 默认。看整体在干什么，最不容易误判 |
| `panel` | 右下 | 属性面板：修改器名、模式 |
| `outliner` | 右上 | 大纲：物体名、层级 |
| `status` | 底部 | 当前命令提示 |
| `keys` | 左下 | Screencast Keys 的按键显示 |
| `subtitle` | 底部横条 | 硬字幕（见下） |
| `custom` | `crop` 参数 | `"x0,y0,x1,y1"`（相对坐标 0–1） |

**布局因 UP 而异**：有人右下是大纲、有人中右是浮动 N 面板、有人窗口录制带 Windows 任务栏。预设只是默认值。

## 硬字幕：自动定位不稳定

不少教程把解说烧成画面底部的大字（约 30px，远大于 UI 的 6–8px），480p 下逐字可读。那是「为什么这么做」的廉价来源。

但**自动定位「有字幕的那一秒」没做稳**：字幕带里同时有 3D 视口在动，帧差信号不纯；用「白像素 + 黑底 + 边缘」三特征也没有分干净（黑色片头会被误判成字幕）。实测抽 3 帧中 1 帧。

现状：`subtitle` 区域用于手动裁切定位。要全片字幕时间轴需要 OCR，或按固定间隔扫描整条带子。

## 关于清晰度

流程理解不需要高清晰度：菜单名、修改器、模式切换在 480p 下可读。

只有想抄参数数值时才需要 720p / 1080p（B站未登录只给 480p，登录可到 720p，大会员到 1080p）。真需要时给个登录态即可，一次配置：

```text
~/.dsh/bili-sessdata.txt    一行：SESSDATA=xxxx
```

只在探测登录状态时使用，不写入日志、不放进命令行、不回显内容。

## 已知限制

### 源与平台（不可抗）

| 限制 | 后果 | 绕法 |
|---|---|---|
| **没有登录凭据** | 一个原因，两处后果：① 清晰度封顶 480p，UI 文字 6–8 px，**参数数值不可读**——像素里就没有，超分/锐化都救不回；② 字幕接口不下发（`need_login_subtitle: true`，`subtitles: []`） | 提供一次 `SESSDATA`（浏览器登录 B站后的同名 Cookie），清晰度与字幕**同时**解锁 |
| 直链带 `deadline`（约 2 小时） | 长时间任务可能用到过期地址 | 每次 grab/scan 都重新解析，天然规避 |
| 宿主 SenseVoice 要两个插件同时配好 | 缺 `subprocess` 或 `dataRoot` → provider 不注册，调用方只看到 "Prepare the local speech provider before recording" | 见「音频转写」的 patch 片段 |
| SenseVoice 只认严格 44 字节 WAV 头 | ffmpeg 的 wav 带 LIST 块，`data` 偏移不是 36，直接判 "Invalid speech WAV" | 引擎从裸 PCM 拼头（已内置） |

### 采样与识别（当前实现的上限）

| 限制 | 说明 |
|---|---|
| 事件分类是粗粒度的 | 只分 `menu` / `object` / `params` / `scene` / `view`，不认具体命令 |
| 长 span 可能含多个操作 | 例如连续 170 秒都在开菜单，需要区间内再加密抽帧 |
| 密度网格是 5 分钟 | 短于 1 秒的瞬时操作可能落在两格之间，靠事件表兜 |
| 30 秒硬切片 | 段交界处有半句重叠（`00:29–00:31` 与 `00:30–00:33`）。宿主 SenseVoice 的 VAD 能避开，但当前切片是机械的 |
| `slides` 的采样已自动化，但 `video_digest`/`video_sweep` 还没接 | `video_outline` 会按切换点分段一页一帧；单独用 `video_sweep` 时仍要自己传区间 |
| 区域预设只是默认值 | 布局因 UP 而异（有人右上是属性面板、有人中右是浮动 N 面板、有人带任务栏），要 `crop` 精调 |
| 硬字幕分句仍可能拆句 | 说话人切换、角色立绘跳动都会干扰 |
| 时间合成只在「字只增不减」时有用 | `median` 在静止页有效；**`union` / `average` 已实测：整句替换的字幕上会叠成重影**（旧字被擦、新字整句换掉，两段内容对不上）。整句字幕用 `video_caption` 的「取最全帧」 |

### 明确没做

- **不做 OCR**：参数值只能靠看图，不给结构化文本。
- **不写笔记**：只产出素材（时间轴、字幕、帧），成文交给调用方。
- **不做音频事件**：笑声、音效、BGM 变化都不识别。
- **跑马灯拼接（slit-scan）未实现**：缺真实样本，只有算法推演。
- **无音轨的视频**：`video_asr` 直接失败，不会假装转写过。


## 依赖

- Python 3.10+，带 `numpy` + `Pillow`
- ffmpeg：优先 `imageio_ffmpeg` 自带的，其次 PATH

解释器探测：`pythonPath` 配置 → `DSH_VIDEO_PYTHON` → `$DSH_HOME/dsh-runtimes/*/dependencies/python/python.exe` → `~/.dsh/dsh-runtimes/...` → PATH。

### 装 ffmpeg

推荐把 `imageio_ffmpeg` 装进 DSH 自己的 Python —— 它自带 ffmpeg 二进制，不用改 PATH：

```sh
<解释器绝对路径> -m pip install imageio_ffmpeg
```

Windows 桌面端通常是：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" -m pip install imageio_ffmpeg
```

装完跑一次 `video_probe` 验证，返回里的 `ffmpeg` 字段就是实际使用的二进制路径。

插件**默认不自行安装依赖**（不改动用户的运行环境）。确实希望启动时自动补装，在 profile 的 `cordis.patch.yml` 里显式打开：

```yaml
- id: dsh-video-read-learn
  name: dsh-video-read-learn
  config:
    autoInstallFfmpeg: true
```

缺失时启动日志会给出可直接复制的安装命令。

## 许可

[MIT](LICENSE)。

插件只做「读」，不下载、不转存视频内容；抓取走的是 B站自己的 `playurl` 接口，按当前账号的权限拿流。
用它批量处理他人作品并再分发，责任在使用者——请遵守 B站的服务条款和原作者的权利。

