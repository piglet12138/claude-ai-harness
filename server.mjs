import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
// (top-level mkdir import removed — its only top-level use moved to lib/state.mjs)
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import { dbUsers, dbSessions, dbThreads, dbMessages, dbDocuments, dbBulkImport, dbUsage, dbRatings, dbPv, dbTelemetry, dbToolResultSummary, dbMemory, dbUserData, dbShares } from "./db.mjs";
import { fileStore, longDocJobs, FILES_DIR } from "./lib/state.mjs";
import { delay, stripTags, chunkText, safeParseJson, escapeHtml, extractTextFromHtml } from "./lib/util.mjs";
import { callHaiku, summarizeWithHaiku, extractRelevant, callClaude } from "./lib/llm.mjs";
import { multiSearch, braveSearch, fetchPageText } from "./tools/web.mjs";
import { executeGenerateLongDoc, buildDocxBuffer, safeDocFilename } from "./skills/docx/index.mjs";
import { executeCode } from "./tools/code-exec.mjs";
import { generateImage } from "./tools/image-gen.mjs";
import { makePptx } from "./tools/pptx-make.mjs";
import { readJson, readBuffer, json, html, notFound } from "./lib/http.mjs";
import { googleStatus, startGoogleAuth, googleCallback, uploadGoogleDoc } from "./integrations/google.mjs";
const XLSX = require("xlsx");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, TableRow, TableCell, Table, WidthType, BorderStyle, PageBreak } = require("docx");

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

// Config + key pool + provider routing extracted to lib/config.mjs.
import {
  env, port, baseUrl, apiKey, model,
  deepseekApiKey, deepseekBaseUrl, deepseekModel, deepseekHaikuModel,
  reqCtx, llmProvider, deepseekProvider,
  accessEmail, accessPassword, sessionSecret,
  braveApiKey, serperApiKey, tavilyApiKey, googleCseApiKey, googleCseCx,
  exaApiKey, firecrawlApiKey, serpApiKey, searchApiKey,
  extractMode, autoFetchN, inlineRichChars,
  webSearchEnabled, webSearchCount, webSearchQueryCount,
  googleClientId, googleClientSecret, googleRedirectUri, googleTokenFile, googleScopes, googleOauthStates,
  resendApiKey, notifyEmails,
  apiEndpoint, HAIKU_MODEL, PROACTIVE_TOKEN_BUDGET, HARD_CAP, IN_LOOP_TOKEN_BUDGET,
  pickKey, markKeyFailed, markKeyOk,
} from "./lib/config.mjs";

async function sendNotifyEmail(subject, text, html) {
  if (!resendApiKey || !notifyEmails.length) return;
  try {
    const payload = {
      from: "Claude Lite <noreply@yaoyuheng2001.me>",
      to: notifyEmails,
      subject,
    };
    if (html) payload.html = html; else payload.text = text;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resendApiKey}` },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    console.log(`[Email] ${resp.ok ? "Sent" : "Failed"}: ${subject}`, resp.ok ? "" : JSON.stringify(data));
  } catch (e) {
    console.error("[Email] Error:", e.message);
  }
}
// Global crash protection
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", String(reason));
});

const agenticSystemPromptText = [
  "你是一个极其聪明、有深度的 AI 助手。默认用中文。不做身份声明。",
  "回答风格：深度优先，充分展开，结构清晰，不用空洞收尾语。",
  "",
  "## 工具使用策略（严格遵守）",
  "",
  "核心原则：**搜后深读，读完再搜**。宁可少搜几次读透内容，也不要广撒网浅尝辄止。",
  "",
  "搜索流程：",
  "1. 每轮最多调用 1-2 次 web_search（不同角度），不要一次搜 3 个以上",
  "2. 搜索结果中包含了自动抓取的页面全文 —— 认真阅读这些全文内容",
  "3. 如果全文信息不够，用 fetch_url 抓取其他感兴趣的搜索结果 URL",
  "4. 充分消化当前信息后，再决定是否需要换角度搜索",
  "5. 信息足够时立即开始回答，不要为了全面而过度搜索",
  "",
  "工具说明：",
  "- web_search：搜索互联网，返回摘要+自动抓取的全文。用精确关键词，不要整句搜索。",
  "- fetch_url：读取指定 URL 全文。用于深入阅读搜索结果或用户给的链接。",
  "- run_code：执行 JavaScript/Python 代码。用于计算、数据处理、验证、**生成 Office 文件**。",
  "  生成的 .docx/.xlsx/.pptx/.pdf/.csv 文件会自动被捕获并提供下载链接。",
  "  **重要：文件必须保存在当前目录，只写文件名，不要用绝对路径。** 如 'report.docx' 而非 '/tmp/report.docx'。",
  "- generate_long_document：生成长篇报告/白皮书/论文。多个子Agent并行撰写，支持50-100页。",
  "- create_artifact：创建可显示/可下载的文档/网页/代码，在右侧面板显示。**只在用户明确要求时使用。**",
  "",
  "## 默认回答策略（严格遵守）",
  "**核心原则：默认在对话里直接回答，除非用户明确要求生成文档。**",
  "",
  "直接在对话中回答：一切问答、解释、分析、列表、表格、对比、建议等，无论内容多长。",
  "**禁止**主动调用 create_artifact 回答普通问题，即使答案很长，也要直接写在对话里。",
  "",
  "## 何时询问是否需要文档",
  "如果内容**同时满足**以下两个条件，先反问用户：",
  "- 内容明显适合做成独立文档（长篇对比分析 / 详细报告 / 完整方案 / 多表格汇总）",
  "- 用户没有明确要求「生成文档 / 报告 / 白皮书 / artifact」",
  "反问格式：「这个内容需要做成可下载的文档吗，还是直接在对话里回答？」",
  "",
  "## 何时直接调用 create_artifact（无需反问）",
  "仅当用户**明确说**「生成文档」「做成报告」「写一份白皮书」「创建 artifact」「制作网页」「输出代码文件」等时，直接调用 create_artifact。",
  "",
  "## 何时用 generate_long_document vs create_artifact（严格遵守）",
  "- 用户要求「完整报告」「全景报告」「白皮书」「详细文档」「至少X页」「长文档」→ **必须用 generate_long_document**",
  "- 用户要求 20 页以上、或明确说「完整」「全面」「详细」「深度」→ **必须用 generate_long_document**",
  "- 普通博客、短文档、代码文件、网页 → 用 create_artifact",
  "- **绝对不要**用 create_artifact 来生成需要 20 页以上的内容，它无法生成那么长的文档",
  "",
  "## 白皮书 / 长文档生成：先问后做（严格遵守）",
  "",
  "当用户要求「白皮书」「完整报告」「详细文档」「全面分析」「论文」等长文档时：",
  "1. **先用 <<options>> 收集偏好**（目标受众、篇幅偏好、语气风格、重点方向等，3-5 个问题）",
  "2. <<options>> 必须是该轮消息的最后内容，**不要在同一消息里调用任何工具**",
  "3. 等用户提交选项后，将选择合并到 requirements 参数，再调用 generate_long_document",
  "4. generate_long_document 完成后**直接结束**，不要再输出 <<options>> 或 <<suggestions>>",
  "",
  "**docx 格式白皮书/报告**：用 generate_long_document，生成可在线预览的 Markdown；",
  "用户点右侧面板「下载 DOCX」即得 Word 文件。**禁止**再用 run_code 生成同内容的 .docx；",
  "**禁止**再用 create_artifact 生成 HTML 预览版（生成一次，预览一次，不重复）。",
  "",
  "## create_artifact 规则（仅在用户明确要求时执行）",
  "1. 聊天中只用 1-2 句话说明意图",
  "2. 调用 create_artifact 生成完整内容（文档至少2000字，HTML要美观完整，代码要可运行）",
  "3. 之后用 1 句话收尾",
  "4. 绝不在聊天正文中写出文档全文内容",
  "5. content 字段必须有实质内容（至少20字符），空内容或过短内容会被服务端拒绝",
  "",
  "不用 create_artifact：普通问答、解释说明、短回复、简单列表、表格对比（直接写对话）。",
  "",
  "## 修改已有文档（严格遵守）",
  "",
  "当用户说「改一下」「修改」「调整」「更新」「优化」或引用之前生成的内容时：",
  "1. **先调用 `list_artifacts`** 查看当前对话里有哪些已保存文档",
  "2. 找到相关文档后，**调用 `get_artifact(id)`** 读取完整内容",
  "3. 基于现有内容进行**增量修改**，再调用 `create_artifact`（标题相同走 upsert，不新建重复文档）",
  "4. **绝不假设「沙箱临时、文档已丢失」**——已生成的文档全部持久化在数据库中",
  "5. 只有 `list_artifacts` 找不到匹配文档时，才走「重新生成」路径，并明确告知用户",
  "",
  "## 交互式选项",
  "",
  "你有两种交互格式可以使用：",
  "",
  "### 1. 采访/规划选项（当需要了解用户需求时）",
  "当用户的请求比较开放、需要更多信息时，先写一段简短分析（2-3句），然后一次性给出 3-5 个问题让用户选择。格式：",
  "<<options>>",
  '[{"question":"目标受众？","choices":[{"label":"技术人员"},{"label":"管理层"},{"label":"通用读者"}]},{"question":"篇幅偏好？","choices":[{"label":"简洁(1-2页)"},{"label":"中等(5-10页)"},{"label":"详尽(20页+)"}]},{"question":"语气风格？","choices":[{"label":"正式学术"},{"label":"商务专业"},{"label":"轻松易懂"}]}]',
  "<</options>>",
  "规则：",
  "- 一次给 3-5 个问题，每个问题 2-4 个选项",
  "- 每个 choice 有 label（必须），desc 可选",
  "- 用户点选后所有选择一次性发回",
  "- 正文先写一些分析/说明，然后给 <<options>>",
  "- ⚠️ 严格规则：<<options>>...<</options>> 块必须是 message 的最后部分，输出完 <</options>> 后不能再追加任何正文文字",
  "- 可以多轮对话。如果第一轮选择后还需要细化，可以继续用 <<options>> 追问",
  "- 任何时候需要用户做选择，都用 <<options>> 格式，不要用纯文本列表让用户自己打字",
  "- 也可以用于引导思考：比如「你觉得哪个方向更重要？」配选项",
  "- 收集到足够信息后直接开始工作",
  "- 适用：写文档、做方案、技术选型、复杂分析、引导用户思考",
  "",
  "### 2. 建议后续问题（回答完成后）",
  "在完整回答的末尾，生成 2-3 个后续追问建议。格式：",
  "<<suggestions>>",
  '["问题1", "问题2", "问题3"]',
  "<</suggestions>>",
  "规则：具体、有价值、20字以内。简单闲聊可以不加。",
  "",
  "## 生成 Office 文件（run_code 高级用法）",
  "",
  "当用户要求生成可下载的 Word/Excel/PPT/PDF 文件时，用 run_code 执行代码生成文件。",
  "文件保存在当前目录即可，系统会自动捕获并提供下载链接。",
  "",
  "### DOCX (Word) — JavaScript, 用 docx 库",
  "```javascript",
  'const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,',
  '  AlignmentType, WidthType, BorderStyle, PageBreak, Header, Footer, PageNumber,',
  '  ImageRun, ExternalHyperlink, LevelFormat, ShadingType } = require("docx");',
  'const fs = require("fs");',
  "const doc = new Document({",
  "  styles: { default: { document: { run: { font: 'Arial', size: 24 } } } },",
  "  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },",
  "    children: [ new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Title')] }) ] }]",
  "});",
  'Packer.toBuffer(doc).then(buf => fs.writeFileSync("output.docx", buf));',
  "```",
  "要点：页面默认A4，美国信纸用 12240x15840 DXA；用 LevelFormat.BULLET 做列表，不要用 unicode 符号；",
  "表格必须设 columnWidths + cell width，用 WidthType.DXA；图片需要 type 参数。",
  "",
  "### XLSX (Excel) — Python, 用 openpyxl",
  "```python",
  "from openpyxl import Workbook",
  "from openpyxl.styles import Font, PatternFill, Alignment",
  "wb = Workbook()",
  "ws = wb.active",
  "ws.title = 'Sheet1'",
  "ws['A1'] = 'Header'",
  "ws['A1'].font = Font(bold=True)",
  "ws.column_dimensions['A'].width = 20",
  "ws['B2'] = '=SUM(B3:B10)'  # 用公式，不要硬编码计算值",
  "wb.save('output.xlsx')",
  "```",
  "要点：用 Excel 公式而非 Python 计算硬编码；openpyxl 的行列从 1 开始。",
  "",
  "### PPTX (PowerPoint) — 用 make_pptx 工具构建（把下面这套 pptxgenjs 脚本作为 code 传给它；它带渲染+视觉 QA 闭环，不过关会回缺陷让你改了重调）。目标：代码构建 + 图标 + 设计系统的专业水准，不是模板填充。",
  "**第一步永远是策划**：先想清每页核心观点、信息层级（主/次/辅）、用哪种版式承载，再写代码。绝不每页都「标题 + 一串 bullet」。",
  "**设计系统（开头定义一次、全程复用）**：",
  "- 调色板用常量，**十六进制不带 #**（带 # 会让 pptxgenjs 生成损坏文件）。深色主题示例：NAVY='08263F', TEAL='0E9488', CYAN='22D3EE', INK='0E2436', MUTED='5E7A8C', LIGHT='F2F8FA', WHITE='FFFFFF'。",
  "- 字体配对：标题衬线 HEAD='Century Schoolbook'，正文无衬线 BODY='Calibri'（建立层级、去 AI 味）。",
  "- 阴影必须用**工厂函数**、每次返回新对象：const shadow=()=>({type:'outer',color:'0A2030',blur:9,offset:3,angle:90,opacity:0.16})，用 shadow:shadow()。**绝不把同一个 shadow 对象复用到多个形状**（否则生成 PowerPoint 打不开的损坏文件）。",
  "- 去「AI 味」：不要标题下划线、不要左侧竖色条、不要纯黑白底；深色页用同色系大圆形（OVAL + transparency 60~80）做氛围层次。",
  "**图标 + 确定性 QA**：环境已装 react-icons/react/react-dom/sharp（图标渲染成 PNG 内嵌，专业感来源），并有 `require('pptx-qa')` 提供确定性硬卡口（对比度/重叠/越界/字号，build 时 throw，先于渲染+视觉，省一次 vision 调用）。**.cjs 不支持顶层 await，整段包在 (async()=>{ ... })() 里。** 骨架：",
  "```javascript",
  'const pptxgen=require("pptxgenjs"), React=require("react"), RD=require("react-dom/server"), sharp=require("sharp"), fa=require("react-icons/fa"), QA=require("pptx-qa");',
  "(async () => {",
  "  const C=QA.TOKENS.color, SZ=QA.TOKENS.size;  // 调色板 + 字号档位（十六进制不带 #）",
  "  const shadow=()=>({type:'outer',color:'0A2030',blur:9,offset:3,angle:90,opacity:0.16});",
  "  const icon=async (Comp,color)=>{const svg=RD.renderToStaticMarkup(React.createElement(Comp,{color:'#'+color,size:'256'}));return 'image/png;base64,'+(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');};",
  "  const p=new pptxgen(); p.layout='LAYOUT_WIDE';  // 画布 13.33 x 7.5 英寸",
  "  const radar=await icon(fa.FaSatelliteDish, C.WHITE);  // react-icons 颜色带 #；pptxgenjs 不带 #",
  "  const s=QA.instrument(p.addSlide());  // instrument 自动登记所有元素，不用手动 track",
  "  s.background={color:C.LIGHT};",
  "  QA.assertReadable(C.TEAL, C.LIGHT, {large:true, label:'kicker'});  // 强调色/标签压底前先验对比度",
  "  s.addText('CORE STRENGTHS',{x:0.7,y:0.45,w:9,h:0.32,fontFace:QA.pickFont('CORE'),fontSize:12,bold:true,color:C.TEAL,charSpacing:3});",
  "  s.addText('六大核心优势',{x:0.7,y:0.74,w:11.4,h:0.7,fontFace:QA.pickFont('六大',{head:true}),fontSize:30,bold:true,color:C.INK});",
  "  // 卡片：背景自定，文字色用 textOn(bg) 自动配对——杜绝浅压浅；大圆氛围装饰标 _role:'decoration'，卡片标 _role:'card'",
  "  const cardBg=C.WHITE, tc=QA.textOn(cardBg);  // 白卡→INK，深卡→WHITE",
  "  s.addShape(p.shapes.ROUNDED_RECTANGLE,{_role:'card',x:0.7,y:2,w:3.9,h:2.2,fill:{color:cardBg},rectRadius:0.1,shadow:shadow()});",
  "  s.addShape(p.shapes.OVAL,{x:1.0,y:2.3,w:0.9,h:0.9,fill:{color:C.TEAL},shadow:shadow()});  // 图标徽章",
  "  s.addImage({data:radar,x:1.23,y:2.53,w:0.44,h:0.44});",
  "  s.addText('全域监控',{x:2.1,y:2.5,w:2.2,h:0.5,fontFace:QA.pickFont('全域',{head:true}),fontSize:SZ.SECTION,bold:true,color:tc});",
  "  QA.assertGeometry(s);  // 每页写文件前自检：越界/装饰压字/卡片重叠，throw 则改了重跑",
  "  await p.writeFile({fileName:'output.pptx'});",
  "})();",
  "```",
  "**版式范式（按内容挑）**：封面=深色底 + 大圆氛围 + 图标徽章 + 衬线大标题 + 数据卡条；要点=2×3 卡网格（每卡圆形图标 + 标题 + 描述）；架构/流程=纵向流（深色条=入口/出口、白卡=并列组件、浅色带=循环），用色块权重区分层级；数据=addChart；双主题=50/50 双栏（一白一深）。",
  "**其它视觉**：框架图/流程图→addShape 方框 + ShapeType.line 箭头（别纯文字罗列）；封面/氛围插图（不需精确文字）可用 generate_image 拿路径再 addImage；但**框架图/流程图/图表绝不用 generate_image**（AI 图文字糊、不可编辑），必须用形状/图标/addChart 画。",
  "**安全红线（用 pptx-qa 强制，每页必做）**：① 每页 `QA.instrument(p.addSlide())` 自动登记，写文件前 `QA.assertGeometry(s)`——只在「元素超出真实画布(13.33×7.5)被裁切」或「卡片显著重叠」时才 throw（轻微超出安全边距不致命，由视觉判官把关）；② **文字颜色一律用 `QA.textOn(背景)` 自动配对**，自选强调色压底前 `QA.assertReadable(色,底,{large?})` 先验（正文 ≥4.5、标签/大字 ≥3.0），杜绝隐形文字；③ 正文字号别超 `SZ.BODY_MAX`(17pt)，标题才大；④ shadow 用工厂函数勿复用同一对象；⑤ ShapeType.line 的 w/h 不能为负（朝左/上用 beginArrowType:'triangle'）；⑥ 颜色十六进制不带 #；⑦ 大圆氛围标 `_role:'decoration'`（可放心出血到画布外、压在文字下做背景，已豁免越界/压字检查）、卡片标 `_role:'card'`（参与重叠检测）。这层过了，make_pptx 还会渲染+视觉判官兜底。",
  "",
  "### PDF — Python, 用 reportlab",
  "```python",
  "from reportlab.lib.pagesizes import letter",
  "from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer",
  "from reportlab.lib.styles import getSampleStyleSheet",
  "doc = SimpleDocTemplate('output.pdf', pagesize=letter)",
  "styles = getSampleStyleSheet()",
  "story = [Paragraph('Title', styles['Title']), Spacer(1,12), Paragraph('Content', styles['Normal'])]",
  "doc.build(story)",
  "```",
  "要点：不要用 unicode 上下标（会变黑块），用 <sub>/<super> 标签。",
  "",
  "### 选择指南",
  "- 用户说「Word文档」「docx」（简短独立文件，非报告/白皮书）→ 用 docx (JS) via run_code",
  "- 用户说「docx白皮书」「Word格式报告」「下载Word版」→ 用 generate_long_document（内置预览，点「下载DOCX」获取Word）",
  "- 用户说「Excel」「表格文件」「xlsx」→ 用 openpyxl (Python)",
  "- 用户说「PPT」「幻灯片」「演示文稿」「pptx」→ **用 make_pptx 工具**（不是 run_code）：把整段 pptxgenjs 脚本作为 code 传进去。它会跑代码 + 渲染 + 视觉 QA。**失败处理铁律**：① 若返回「代码执行失败/几何自检失败/对比度不足」——这是确定性硬错误，**只改报错明确指出的那几个元素**（某个越界坐标、某处低对比色、某个语法 typo），**绝不整份重写**（整份重写极易引入新的逗号/字段 typo，陷入越改越坏的死循环）；② 若返回「视觉 QA 发现问题」——文件其实已经可下载了，只需针对清单里的点微调后再调一次即可，最多再试 1–2 次就够，不要无限纠结美观。pptxgenjs 写法、设计系统、QA 卡口同上。",
  "- 用户说「PDF」→ 用 reportlab (Python)",
  "- 不确定格式时，优先用 create_artifact 生成 HTML 文档（可在线预览）",
  "- run_code 生成了 .docx/.xlsx/.pptx/.pdf 文件后，**禁止**再用 create_artifact 生成 HTML 预览",
].join("\n");
function buildSystemPrompt(memory) {
  const memoryText = `\n\n## 长期记忆\n你有一个跨对话的长期记忆系统。\n当前用户 memory：\n${memory || "（暂无）"}\n\n何时主动 append：用户告诉你他的身份、职业、正在做的项目、长期偏好时。\n何时主动 read：当前对话开始或需要回顾用户背景时。\n何时 replace：memory 超过 30 行或内容明显冗余时整理。\n不要把对话内一次性信息记进 memory。`;
  return [
    { type: "text", text: agenticSystemPromptText, cache_control: { type: "ephemeral" } },
    { type: "text", text: memoryText },
  ];
}

const anthropicTools = [
  {
    name: "web_search",
    description: "Search the web for current information, facts, data, news. Supports Chinese and English. Tips: (1) Use specific keywords, not full sentences. (2) For Chinese topics, search in Chinese. (3) Call multiple times with different angles for comprehensive research. (4) After searching, the system auto-reads top results for full content.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, concise and specific" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch and extract text content from a URL. Use when you need to read a specific webpage, article, documentation, or any online resource. Returns the main text content. Pass `goal` to keep only the parts relevant to what you're looking for.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        goal: { type: "string", description: "What you're trying to find on this page (a question or topic). The page is filtered to keep only content relevant to this. Strongly recommended." },
      },
      required: ["url"],
    },
  },
  {
    name: "run_code",
    description: "Execute JavaScript or Python code. Use for calculations, data processing, generating charts, or demonstrating code. Python has numpy, pandas, matplotlib, openpyxl, reportlab available. JavaScript has docx, pptxgenjs, react-icons, react, react-dom, sharp available via require() (react-icons + sharp let you render vector icons to PNG and embed them into pptx). Generated files (.docx, .xlsx, .pptx, .pdf, .csv) are auto-captured and provided as download links. Matplotlib charts are auto-captured as inline images.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["javascript", "python"], description: "Programming language" },
        code: { type: "string", description: "The code to execute" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "generate_image",
    description: "Generate an illustration/concept image from a text prompt (AI image generation). Use for: hero/cover images, concept art, atmospheric illustrations, decorative visuals — especially for PPT slides. Returns an absolute file path you can embed in a later run_code call via pptxgenjs `slide.addImage({ path })`. IMPORTANT: do NOT use this for diagrams that need accurate text/structure (framework diagrams, flowcharts, charts) — those must be drawn natively with pptxgenjs shapes/lines or addChart, because AI images render text garbled and are not editable. Write the prompt in English for best quality; end prompts with 'no text, no words' when the image must not contain text.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed English description of the image. For text-free images, append 'no text, no words'." },
        size: { type: "string", enum: ["1536x1024", "1024x1024", "1024x1536"], description: "Image size. Use 1536x1024 (landscape) for PPT cover/hero; default 1536x1024." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "make_pptx",
    description: "Build a PowerPoint (.pptx) from pptxgenjs JavaScript code, with a built-in render + visual QA loop. ALWAYS use this (not run_code) when the user wants slides/a deck/PPT/演示文稿. Pass the full pptxgenjs script as `code` (same environment as run_code: pptxgenjs/react-icons/sharp available; wrap in an async IIFE; write to 'output.pptx'). The tool runs your code, renders the slides to images, and has a vision model inspect them for invisible/low-contrast text, overflow, overlap, and imbalance. If QA fails it returns a per-slide defect list and NO downloadable file — fix the coordinates/colors in your code and call make_pptx again. If QA passes it returns the downloadable .pptx. Follow the PPTX design-system guidance in the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Full pptxgenjs JS script (async IIFE) that writes 'output.pptx'." },
        fileName: { type: "string", description: "Download filename, e.g. 'BettaFish_介绍.pptx'. Optional." },
      },
      required: ["code"],
    },
  },
  {
    name: "generate_long_document",
    description: "Generate a long professional document (20-100 pages) by orchestrating multiple sub-agents writing in parallel. Use ONLY when the user explicitly requests a long/detailed document, report, white paper, or comprehensive guide that needs 20+ pages. Each sub-agent can search the web for up-to-date information. Do NOT use for short documents or simple questions.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Document topic and title" },
        requirements: { type: "string", description: "Detailed requirements: audience, scope, style, specific sections to include" },
        pages: { type: "number", description: "Target page count, 10-100. Default 30." },
      },
      required: ["topic"],
    },
  },
  {
    name: "create_artifact",
    description: "Create a document or interactive artifact shown in the user's side panel. ONLY call this tool when the user explicitly requests creating/generating a document, report, HTML page, code file, or other artifact. Do NOT use to answer questions, even long ones — default to replying in the chat instead. Do NOT proactively create artifacts without an explicit user request.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, max 50 chars" },
        type: { type: "string", enum: ["html", "document", "code"], description: "html: self-contained HTML/CSS/JS page or app. document: Markdown text. code: source code file." },
        content: { type: "string", description: "Full content of the artifact" },
        language: { type: "string", description: "e.g. html, markdown, javascript, python" },
        description: { type: "string", description: "One-line description of the artifact" },
        file_path: { type: "string", description: "Suggested filename, e.g. index.html, report.md" },
      },
      required: ["title", "type", "content"],
    },
  },
  {
    name: "list_artifacts",
    description: "List all artifacts/documents saved in the current conversation thread. Call this first whenever the user asks to modify, update, or reference a previously created document — to check if it exists and get its ID. Do NOT assume documents are gone just because the sandbox is temporary; all artifacts are persisted in the database.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "manage_memory",
    description: "管理跨对话的长期记忆。在主对话中发现值得长期记住的事实/偏好时调用。包括：用户的身份、职业、所在城市、长期兴趣、技术栈偏好、当前正在做的项目、明确表达过的偏好（如「请用中文」「不要用 emoji」）。**不要记录**：一次性问题、对话内的临时上下文、敏感信息（密码、身份证号）。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "append", "replace"], description: "read 读取当前 memory；append 追加一行；replace 全量替换（用于整理压缩）" },
        content: { type: "string", description: "append 时是要追加的内容（一行）；replace 时是新的完整 memory；read 时忽略" },
      },
      required: ["action"],
    },
  },
  {
    name: "get_artifact",
    description: "Get the full content of a specific artifact/document by its ID. Use after list_artifacts to read an existing document before making incremental edits to it.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artifact ID from list_artifacts" },
      },
      required: ["id"],
    },
    cache_control: { type: "ephemeral" },
  },
];
// apiEndpoint / HAIKU_MODEL / token budgets / key pool (pickKey, markKeyFailed,
// markKeyOk) and the required-config guards now live in lib/config.mjs.

// ---------------------------------------------------------------------------
// User management (SQLite)
// ---------------------------------------------------------------------------
const loginAttempts = new Map(); // ip -> { count, resetAt }

function hashPwd(password, salt) {
  return crypto.createHash("sha256").update(password + salt).digest("hex");
}

function seedAdmin() {
  const existing = dbUsers.getByEmail(accessEmail);
  if (existing) return;
  // Also check if any users exist at all
  const users = dbUsers.list();
  if (users.length) return;
  const salt = crypto.randomBytes(16).toString("hex");
  dbUsers.create(crypto.randomUUID(), accessEmail, hashPwd(accessPassword, salt), salt, "admin");
}
seedAdmin();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, { ok: true, ts: Math.floor(Date.now() / 1000) });
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const session = readSession(req);
      return json(res, { authenticated: Boolean(session), email: session?.email || "", role: session?.role || "", model });
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const ip = req.socket.remoteAddress || "";
      if (isRateLimited(ip)) return json(res, { error: "操作过于频繁，请稍后再试" }, 429);
      const body = await readJson(req, 32 * 1024);
      const email = String(body?.email || "").trim().toLowerCase();
      const password = String(body?.password || "");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { error: "邮箱格式不正确" }, 400);
      if (password.length < 6) return json(res, { error: "密码至少 6 位" }, 400);
      if (dbUsers.getByEmail(email)) return json(res, { error: "该邮箱已注册" }, 409);
      const salt = crypto.randomBytes(16).toString("hex");
      const user = { id: crypto.randomUUID(), email, passwordHash: hashPwd(password, salt), salt, role: "user" };
      dbUsers.create(user.id, email, user.passwordHash, salt, "user");
      const token = createSession(user);
      res.setHeader("Set-Cookie", `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800`);
      return json(res, { ok: true, email: user.email });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const ip = req.socket.remoteAddress || "";
      if (isRateLimited(ip)) return json(res, { error: "操作过于频繁，请稍后再试" }, 429);
      const body = await readJson(req, 32 * 1024);
      const email = String(body?.email || "").trim().toLowerCase();
      const password = String(body?.password || "");
      const user = dbUsers.getByEmail(email);
      if (!user || hashPwd(password, user.salt) !== user.password_hash) {
        recordAttempt(ip);
        return json(res, { error: "账号或密码不正确" }, 401);
      }
      const token = createSession(user);
      res.setHeader("Set-Cookie", `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800`);
      return json(res, { ok: true, email: user.email });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const session = readSession(req);
      if (session) dbSessions.delete(getCookieToken(req));
      res.setHeader("Set-Cookie", "claude_lite=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0");
      return json(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      return json(res, dbUsers.list());
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      const body = await readJson(req, 32 * 1024);
      const email = String(body?.email || "").trim().toLowerCase();
      const password = String(body?.password || "");
      const role = body?.role === "admin" ? "admin" : "user";
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { error: "邮箱格式不正确" }, 400);
      if (password.length < 6) return json(res, { error: "密码至少 6 位" }, 400);
      if (dbUsers.getByEmail(email)) return json(res, { error: "该邮箱已注册" }, 409);
      const salt = crypto.randomBytes(16).toString("hex");
      const id = crypto.randomUUID();
      dbUsers.create(id, email, hashPwd(password, salt), salt, role);
      return json(res, { ok: true, id, email, role });
    }

    if (url.pathname.startsWith("/api/admin/users/") && url.pathname.split("/").length === 5) {
      const userId = url.pathname.split("/")[4];
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);

      if (req.method === "PATCH") {
        const body = await readJson(req, 32 * 1024);
        if (body.role) {
          const newRole = body.role === "admin" ? "admin" : "user";
          dbUsers.updateRole(userId, newRole);
        }
        if (body.password) {
          if (body.password.length < 6) return json(res, { error: "密码至少 6 位" }, 400);
          const salt = crypto.randomBytes(16).toString("hex");
          dbUsers.updatePassword(userId, hashPwd(body.password, salt), salt);
        }
        return json(res, { ok: true });
      }

      if (req.method === "DELETE") {
        if (userId === session.userId) return json(res, { error: "不能删除自己" }, 400);
        dbUsers.delete(userId);
        return json(res, { ok: true });
      }
    }

    // =========================================================================
    // Thread / Message / Document API (SQLite-backed)
    // =========================================================================

    if (req.method === "GET" && url.pathname === "/api/threads") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threads = dbThreads.list(session.userId);
      return json(res, threads);
    }

    if (req.method === "POST" && url.pathname === "/api/threads") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 64 * 1024);
      const id = body.id || crypto.randomUUID();
      dbThreads.create(id, session.userId, body.title || "新对话", body.archived ? 1 : 0, body.starred ? 1 : 0, body.createdAt, body.updatedAt);
      return json(res, { ok: true, id });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/threads/") && !url.pathname.includes("/messages") && !url.pathname.includes("/documents")) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      const body = await readJson(req, 32 * 1024);
      const existing = dbThreads.get(threadId, session.userId);
      if (!existing) return json(res, { error: "Not found" }, 404);
      dbThreads.update(threadId, session.userId, body.title ?? existing.title, body.archived ?? existing.archived, body.starred ?? existing.starred);
      return json(res, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/threads/") && !url.pathname.includes("/messages") && !url.pathname.includes("/documents")) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      dbThreads.delete(threadId, session.userId);
      return json(res, { ok: true });
    }

    // Messages
    if (req.method === "GET" && url.pathname.match(/^\/api\/threads\/[^/]+\/messages$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const messages = dbMessages.list(threadId);
      return json(res, messages);
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/threads\/[^/]+\/messages$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const body = await readJson(req, 512 * 1024);
      if (Array.isArray(body)) {
        dbMessages.appendBatch(threadId, body);
      } else {
        dbMessages.append(threadId, body);
      }
      // Touch thread updated_at
      const t = dbThreads.get(threadId, session.userId);
      if (t) dbThreads.update(threadId, session.userId, t.title, t.archived, t.starred);
      return json(res, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/threads\/[^/]+\/messages$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const param = url.searchParams.get("action");
      if (param === "deleteLast") {
        dbMessages.deleteLast(threadId);
      } else {
        dbMessages.clearThread(threadId);
      }
      return json(res, { ok: true });
    }

    // Documents
    if (req.method === "GET" && url.pathname.match(/^\/api\/threads\/[^/]+\/documents$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      return json(res, dbDocuments.list(threadId));
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/threads\/[^/]+\/documents$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const doc = await readJson(req, 2 * 1024 * 1024);
      doc.id = doc.id || crypto.randomUUID();
      dbDocuments.upsert(threadId, doc);
      return json(res, { ok: true, id: doc.id });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/documents\/[^/]+$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const docId = url.pathname.split("/")[3];
      dbDocuments.delete(docId);
      return json(res, { ok: true });
    }

    // Bulk import (migration from localStorage)
    if (req.method === "POST" && url.pathname === "/api/migrate") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 50 * 1024 * 1024); // up to 50MB
      const threads = Array.isArray(body.threads) ? body.threads : [];
      if (!threads.length) return json(res, { ok: true, imported: 0 });
      // Skip threads that already exist
      const existing = new Set(dbThreads.list(session.userId).map(t => t.id));
      const newThreads = threads.filter(t => !existing.has(t.id));
      if (newThreads.length) {
        dbBulkImport(session.userId, newThreads);
      }
      return json(res, { ok: true, imported: newThreads.length, skipped: threads.length - newThreads.length });
    }

        if (req.method === "POST" && url.pathname === "/api/bug-report") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 10 * 1024 * 1024); // 10MB for images
      const text = String(body?.text || "").trim().slice(0, 2000);
      const threadId = typeof body?.threadId === 'string' ? body.threadId.slice(0, 200) : null;
      const rawImages = Array.isArray(body?.images) ? body.images.slice(0, 5) : [];
      if (!text && !rawImages.length) return json(res, { error: "内容不能为空" }, 400);
      // Save images to disk, store paths in report
      const imgDir = path.join(root, "bug-images");
      await fs.mkdir(imgDir, { recursive: true });
      const imagePaths = [];
      for (const dataUrl of rawImages) {
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) continue;
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const fname = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
        await fs.writeFile(path.join(imgDir, fname), Buffer.from(match[2], "base64"));
        imagePaths.push(`/bug-images/${fname}`);
      }
      const reportsFile = path.join(root, "bug-reports.json");
      let reports = [];
      try { reports = JSON.parse(await fs.readFile(reportsFile, "utf8")); } catch {}
      reports.push({ id: crypto.randomUUID(), email: session.email, text, images: imagePaths, ...(threadId ? { threadId } : {}), userAgent: String(req.headers["user-agent"] || "").slice(0, 200), createdAt: new Date().toISOString() });
      await fs.writeFile(reportsFile, JSON.stringify(reports, null, 2), "utf8");
      // Send email notification with images (non-blocking)
      const siteUrl = `https://claude.yaoyuheng2001.me`;
      const imgsHtml = imagePaths.map(p => `<p><img src="${siteUrl}${p}" style="max-width:600px;border-radius:8px;border:1px solid #ddd" /></p>`).join("");
      const threadHtml = threadId ? `<p style="font-size:13px;color:#555">Thread: <a href="${siteUrl}/admin?thread=${encodeURIComponent(threadId)}">${threadId}</a></p>` : '';
      sendNotifyEmail(
        `[Bug Report] ${text.slice(0, 50)}`,
        null,
        `<div style="font-family:sans-serif;max-width:640px"><p style="color:#666">From: ${session.email}</p>${threadHtml}<p style="white-space:pre-wrap;line-height:1.6">${text.replace(/</g,"&lt;")}</p>${imgsHtml}<hr style="border:none;border-top:1px solid #eee;margin:20px 0"><p style="font-size:12px;color:#999"><a href="${siteUrl}/admin">管理后台</a></p></div>`
      ).catch(() => {});
      return json(res, { ok: true });
    }

    // Long-term memory — read/replace user's memory
    if (req.method === "GET" && url.pathname === "/api/memory") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      return json(res, { content: dbMemory.get(session.userId) });
    }

    if (req.method === "PUT" && url.pathname === "/api/memory") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 32 * 1024);
      dbMemory.replace(session.userId, String(body?.content || ""));
      return json(res, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname === "/api/memory") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      dbMemory.replace(session.userId, "");
      return json(res, { ok: true });
    }

    // My Data: summary stats
    if (req.method === "GET" && url.pathname === "/api/me/summary") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const summary = dbUserData.summary(session.userId);
      const memMeta = dbMemory.getMeta(session.userId);
      const user = dbUsers.getById(session.userId);
      return json(res, {
        email: session.email,
        created_at: user?.created_at || "",
        threads: summary.threads,
        messages: summary.messages,
        documents: summary.documents,
        telemetry: summary.telemetry,
        memory_chars: (memMeta?.content || "").length,
      });
    }

    // My Data: full export (triggers download)
    if (req.method === "GET" && url.pathname === "/api/me/export") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const user = dbUsers.getById(session.userId);
      const memMeta = dbMemory.getMeta(session.userId);
      const threads = dbUserData.getAllThreads(session.userId).map(t => ({
        ...t,
        messages: dbMessages.list(t.id),
        documents: dbDocuments.list(t.id),
      }));
      const telemetry = dbUserData.getTelemetry(session.userId);
      const ratings = dbUserData.getRatings(session.userId);
      let bugReports = [];
      try {
        const reportsFile = path.join(root, "bug-reports.json");
        const all = JSON.parse(await fs.readFile(reportsFile, "utf8"));
        bugReports = all.filter(r => r.email === session.email);
      } catch {}
      const exportData = {
        exported_at: new Date().toISOString(),
        user: { email: session.email, created_at: user?.created_at || "" },
        memory: { content: memMeta?.content || "", updated_at: memMeta?.updated_at || "" },
        threads,
        telemetry,
        ratings,
        bug_reports: bugReports,
      };
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `my-data-${session.email.replace(/[^a-zA-Z0-9]/g, "-")}-${dateStr}.json`;
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(exportData, null, 2));
      return;
    }

    // My Data: delete all user data
    if (req.method === "DELETE" && url.pathname === "/api/me") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 1024);
      if (body?.confirm !== "DELETE_ALL_MY_DATA") {
        return json(res, { error: "confirm 字段必须为 DELETE_ALL_MY_DATA" }, 400);
      }
      // Remove matching bug-reports entries and their images
      try {
        const reportsFile = path.join(root, "bug-reports.json");
        let reports = JSON.parse(await fs.readFile(reportsFile, "utf8"));
        const toDelete = reports.filter(r => r.email === session.email);
        reports = reports.filter(r => r.email !== session.email);
        await fs.writeFile(reportsFile, JSON.stringify(reports, null, 2), "utf8");
        for (const report of toDelete) {
          for (const imgPath of (report.images || [])) {
            const fname = path.basename(imgPath);
            fs.unlink(path.join(root, "bug-images", fname)).catch(() => {});
          }
        }
      } catch {}
      // Delete all DB data (telemetry, ratings, usage, then user — cascades sessions/threads/memory)
      dbUserData.deleteAll(session.userId);
      // Invalidate session cookie
      res.writeHead(204, {
        "set-cookie": "claude_lite=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    // Usage stats — user sees own, admin sees all
    if (req.method === "GET" && url.pathname === "/api/usage") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const today = dbUsage.userToday(session.userId);
      const total = dbUsage.userAll(session.userId);
      const daily = dbUsage.userDaily(session.userId);
      return json(res, { today, total, daily });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/usage") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      return json(res, dbUsage.allSummary());
    }

    if (req.method === "GET" && url.pathname === "/api/admin/bug-reports") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      const reportsFile = path.join(root, "bug-reports.json");
      let reports = [];
      try { reports = JSON.parse(await fs.readFile(reportsFile, "utf8")); } catch {}
      return json(res, reports.reverse());
    }

    if (req.method === "GET" && url.pathname === "/api/admin/conversations") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      return json(res, dbThreads.listAll());
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/admin/conversations/")) {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      const threadId = url.pathname.split("/")[4];
      const thread = dbThreads.getById(threadId);
      if (!thread) return json(res, { error: "Not found" }, 404);
      const messages = dbMessages.list(threadId);
      const ratings = dbRatings.getThreadRatings(threadId);
      return json(res, { thread, messages, ratings });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/ratings") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      return json(res, { ratings: dbRatings.all(), stats: dbRatings.stats() });
    }

    // User-facing rating API
    if (req.method === "POST" && url.pathname.startsWith("/api/messages/") && url.pathname.endsWith("/rate")) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const parts = url.pathname.split("/");
      const messageId = parts[3];
      const body = await readJson(req, 1024);
      const rating = body?.rating;
      if (rating !== 1 && rating !== -1) return json(res, { error: "rating must be 1 or -1" }, 400);
      const threadId = body?.thread_id;
      if (!threadId) return json(res, { error: "thread_id required" }, 400);
      dbRatings.upsert(messageId, threadId, session.userId, rating);
      return json(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/ratings") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.searchParams.get("thread_id");
      if (!threadId) return json(res, { error: "thread_id required" }, 400);
      return json(res, dbRatings.getThreadRatings(threadId));
    }

    // Analytics: PV tracking
    if (req.method === "POST" && url.pathname === "/api/analytics/pv") {
      try {
        const body = await readJson(req, 4096);
        dbPv.record(body?.path || "", body?.referrer || "", body?.screen || "", body?.fp || "");
      } catch {}
      return json(res, { ok: true });
    }

    // Admin: telemetry export
    if (req.method === "GET" && url.pathname === "/api/admin/telemetry") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      return json(res, { telemetry: dbTelemetry.all(), stats: dbTelemetry.stats() });
    }

    if (req.method === "POST" && url.pathname === "/api/import-docx") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return importDocx(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/status") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return googleStatus(res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/auth/start") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return startGoogleAuth(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/callback") {
      return googleCallback(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/google/upload-doc") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 10 * 1024 * 1024);
      return uploadGoogleDoc(res, body);
    }

    // ── Long doc job status (disconnect recovery) ──
    if (req.method === "GET" && url.pathname.match(/^\/api\/job\/[^/]+$/)) {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const jobId = url.pathname.split("/")[3];
      const job = longDocJobs.get(jobId);
      if (!job) return json(res, { error: "Job not found" }, 404);
      // Return progress since a given index (for incremental polling)
      const since = Number(url.searchParams?.get("since") || 0);
      return json(res, {
        id: job.id,
        status: job.status,
        progress: job.progress.slice(since),
        progressTotal: job.progress.length,
        artifact: job.status === "completed" ? job.artifact : null,
        error: job.error,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 32 * 1024);
      const results = await multiSearch(body?.query);
      return json(res, { results });
    }

    // ── Files: download generated file ──
    if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
      const fileId = url.pathname.slice("/api/files/".length);
      const entry = fileStore.get(fileId);
      if (!entry) { res.writeHead(404); res.end("File not found or expired"); return; }
      try {
        const data = await fs.readFile(entry.filePath);
        const safeName = encodeURIComponent(entry.fileName);
        res.writeHead(200, {
          "content-type": entry.mime,
          "content-disposition": `attachment; filename*=UTF-8''${safeName}`,
          "content-length": data.length,
        });
        res.end(data);
      } catch {
        res.writeHead(410); res.end("File no longer available");
      }
      return;
    }

    // ── Share: create persistent doc link (SQLite) ──
    if (req.method === "POST" && url.pathname === "/api/share") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req);
      const title = String(body?.title || "文档").slice(0, 200);
      const html = String(body?.html || "").slice(0, 2_000_000);
      if (!html) return json(res, { error: "No content" }, 400);
      const id = crypto.randomBytes(8).toString("hex");
      const expiresAt = Date.now() + 30 * 24 * 3600_000;
      dbShares.create(id, "doc", session.userId, title, { html }, expiresAt);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host || "claude.yaoyuheng2001.me";
      const shareUrl = `${proto}://${host}/s/${id}`;
      return json(res, { url: shareUrl, id, expiresAt });
    }

    // ── Share: create thread share link ──
    if (req.method === "POST" && url.pathname === "/api/share/thread") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req);
      const threadId = String(body?.threadId || "");
      if (!threadId) return json(res, { error: "threadId required" }, 400);
      const thread = dbThreads.get(threadId, session.userId);
      if (!thread) return json(res, { error: "Thread not found" }, 404);
      const rawMessages = dbMessages.list(threadId);
      const messages = rawMessages.map(m => {
        const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
        const filtered = content.map(block => {
          if (block.type === "image" || block.type === "document") return { type: "placeholder", text: "[附件已隐藏]" };
          return block;
        });
        return { role: m.role, content: filtered };
      });
      const documents = dbDocuments.list(threadId).map(d => ({
        id: d.id, title: d.title, type: d.type, content: d.content, language: d.language,
      }));
      const id = crypto.randomBytes(8).toString("hex");
      const expiresAt = Date.now() + 30 * 24 * 3600_000;
      dbShares.create(id, "thread", session.userId, thread.title, { messages, documents }, expiresAt);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host || "claude.yaoyuheng2001.me";
      const shareUrl = `${proto}://${host}/s/t/${id}`;
      return json(res, { url: shareUrl, id, expiresAt });
    }

    // ── Share: fork a thread share into current user's account ──
    if (req.method === "POST" && url.pathname.match(/^\/api\/share\/([a-f0-9]+)\/fork$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const shareId = url.pathname.match(/^\/api\/share\/([a-f0-9]+)\/fork$/)[1];
      const share = dbShares.get(shareId);
      if (!share) return json(res, { error: "Share not found" }, 404);
      if (share.revoked_at) return json(res, { error: "Share has been revoked" }, 410);
      if (Date.now() > share.expires_at) return json(res, { error: "Share has expired" }, 410);
      if (share.kind !== "thread") return json(res, { error: "Not a thread share" }, 400);
      const newThreadId = crypto.randomUUID();
      const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
      dbThreads.create(newThreadId, session.userId, `${share.title || "对话"} (fork)`, 0, 0, now, now);
      const { messages, documents } = share.payload;
      const msgs = (messages || []).map(m => ({ ...m, id: crypto.randomUUID() }));
      dbMessages.appendBatch(newThreadId, msgs);
      for (const doc of (documents || [])) {
        dbDocuments.upsert(newThreadId, { ...doc, id: crypto.randomUUID() });
      }
      dbShares.incrementFork(shareId);
      return json(res, { threadId: newThreadId });
    }

    // ── Share: list current user's shares ──
    if (req.method === "GET" && url.pathname === "/api/share/list") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host || "claude.yaoyuheng2001.me";
      const rows = dbShares.listByUser(session.userId).map(r => ({
        ...r,
        url: r.kind === "thread" ? `${proto}://${host}/s/t/${r.id}` : `${proto}://${host}/s/${r.id}`,
      }));
      return json(res, rows);
    }

    // ── Share: revoke a share ──
    if (req.method === "POST" && url.pathname.match(/^\/api\/share\/([a-f0-9]+)\/revoke$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const shareId = url.pathname.match(/^\/api\/share\/([a-f0-9]+)\/revoke$/)[1];
      dbShares.revoke(shareId, session.userId);
      return json(res, { ok: true });
    }

    // ── Share: view shared document (SQLite) ──
    if (req.method === "GET" && url.pathname.startsWith("/s/") && !url.pathname.startsWith("/s/t/")) {
      const id = url.pathname.slice(3);
      const share = dbShares.get(id);
      if (!share || share.kind !== "doc") {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接不存在</h2><p>分享链接不存在或已过期</p></body></html>");
        return;
      }
      if (share.revoked_at) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接已撤销</h2><p>分享者已撤销此链接</p></body></html>");
        return;
      }
      if (Date.now() > share.expires_at) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接已过期</h2><p>分享链接有效期为 30 天</p></body></html>");
        return;
      }
      dbShares.incrementView(id);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(share.payload.html);
      return;
    }

    // ── Share: view shared thread ──
    if (req.method === "GET" && url.pathname.startsWith("/s/t/")) {
      const id = url.pathname.slice(5);
      const share = dbShares.get(id);
      if (!share || share.kind !== "thread") {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接不存在</h2></body></html>");
        return;
      }
      if (share.revoked_at) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接已撤销</h2><p>分享者已撤销此链接</p></body></html>");
        return;
      }
      if (Date.now() > share.expires_at) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接已过期</h2><p>分享链接有效期为 30 天</p></body></html>");
        return;
      }
      dbShares.incrementView(id);
      const { messages, documents } = share.payload;
      const createdDate = new Date(share.created_at).toLocaleDateString("zh-CN");
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host || "claude.yaoyuheng2001.me";
      const forkUrl = `${proto}://${host}/app?fork=${id}`;
      const loginForkUrl = `${proto}://${host}/app?action=login&return=/s/t/${id}&fork=${id}`;

      function renderMessageContent(content) {
        if (!Array.isArray(content)) return escapeHtml(String(content));
        return content.map(block => {
          if (block.type === "text") return `<span>${escapeHtml(block.text)}</span>`;
          if (block.type === "placeholder") return `<em class="share-placeholder">${escapeHtml(block.text)}</em>`;
          return `<em class="share-placeholder">[内容]</em>`;
        }).join("");
      }

      const messagesHtml = (messages || []).map(m => `
        <div class="share-msg share-msg-${m.role}">
          <div class="share-msg-role">${m.role === "user" ? "用户" : "Claude"}</div>
          <div class="share-msg-content">${renderMessageContent(m.content)}</div>
        </div>`).join("\n");

      const docsHtml = (documents || []).length > 0 ? `
        <div class="share-docs">
          <h3>相关文档</h3>
          ${(documents || []).map(d => `<div class="share-doc-card"><strong>${escapeHtml(d.title)}</strong></div>`).join("")}
        </div>` : "";

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(share.title || "分享的对话")} — Claude AI Harness</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f8f8f8;color:#1a1a1a;min-height:100vh}
.share-header{background:#fff;border-bottom:1px solid #e5e5e5;padding:14px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.share-logo{font-weight:700;font-size:18px;color:#1a1a1a;text-decoration:none}
.share-title{flex:1;font-size:16px;font-weight:600;color:#1a1a1a;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.share-fork-btn{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap}
.share-fork-btn:hover{background:#1d4ed8}
.share-meta{background:#fff;border-bottom:1px solid #e5e5e5;padding:10px 24px;font-size:13px;color:#666}
.share-body{max-width:800px;margin:0 auto;padding:24px 16px}
.share-msg{padding:16px;margin-bottom:12px;border-radius:12px;line-height:1.6}
.share-msg-user{background:#fff;border:1px solid #e5e5e5}
.share-msg-assistant{background:#f0f7ff;border:1px solid #c7dfff}
.share-msg-role{font-size:12px;font-weight:600;color:#666;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
.share-msg-content{font-size:15px;white-space:pre-wrap;word-wrap:break-word}
.share-msg-content span{display:block}
.share-placeholder{color:#999;font-style:italic}
.share-docs{margin-top:24px;padding:16px;background:#fff;border-radius:12px;border:1px solid #e5e5e5}
.share-docs h3{font-size:14px;margin-bottom:12px;color:#666}
.share-doc-card{padding:8px 12px;background:#f8f8f8;border-radius:8px;font-size:14px;margin-bottom:8px}
.share-footer{max-width:800px;margin:0 auto;padding:24px 16px;text-align:center;font-size:14px;color:#666;border-top:1px solid #e5e5e5;margin-top:24px}
.share-footer a{color:#2563eb;text-decoration:none}
@media(max-width:600px){.share-header{padding:12px 16px}.share-body{padding:16px 12px}}
</style>
</head>
<body>
<header class="share-header">
  <a class="share-logo" href="/">Claude AI Harness</a>
  <span class="share-title">${escapeHtml(share.title || "分享的对话")}</span>
  <a class="share-fork-btn" href="${forkUrl}" id="forkBtn">Fork 继续聊</a>
</header>
<div class="share-meta">用户分享于 ${createdDate} · 浏览 ${share.view_count + 1} 次</div>
<main class="share-body">
  ${messagesHtml}
  ${docsHtml}
</main>
<footer class="share-footer">
  想继续这段对话？<a href="${forkUrl}">登录后 Fork 一份</a>，接着和 Claude 聊。
</footer>
<script>
document.getElementById('forkBtn').addEventListener('click', function(e) {
  e.preventDefault();
  const url = this.href;
  fetch('/api/me/summary').then(r => {
    if (r.ok) { window.location.href = url; }
    else { window.location.href = ${JSON.stringify(loginForkUrl)}; }
  }).catch(() => { window.location.href = ${JSON.stringify(loginForkUrl)}; });
});
</script>
</body>
</html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }

    // ── Export as DOCX ──
    if (req.method === "POST" && url.pathname === "/api/export-docx") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return exportDocx(req, res);
    }

        if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return chat(req, res);
    }

    if (req.method === "GET" && url.pathname === "/app") {
      return staticFile("/app.html", res);
    }

    if (req.method === "GET" && url.pathname === "/admin") {
      const session = readSession(req);
      if (!session || session.role !== "admin") {
        res.writeHead(302, { Location: "/app" });
        res.end();
        return;
      }
      return staticFile("/admin.html", res);
    }

    // Serve bug report images (admin only in practice, but images are random-named)
    if (req.method === "GET" && url.pathname.startsWith("/bug-images/")) {
      const fname = path.basename(url.pathname);
      const imgPath = path.join(root, "bug-images", fname);
      try {
        const data = await fs.readFile(imgPath);
        const ext = path.extname(fname);
        res.writeHead(200, { "content-type": mime[ext] || "image/png", "cache-control": "public, max-age=86400" });
        res.end(data);
        return;
      } catch { return notFound(res); }
    }

    return staticFile(url.pathname, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, { error: "Server error" }, 500);
    else res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Claude listening on http://127.0.0.1:${port}`);
});

async function importDocx(req, res) {
  const buffer = await readBuffer(req, 16 * 1024 * 1024);
  const mammoth = await import("mammoth");
  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => ({
          src: `data:${image.contentType};base64,${await image.read("base64")}`,
        })),
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => p.subtitle:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
        ],
      },
    ),
    mammoth.extractRawText({ buffer }),
  ]);
  const content = String(textResult.value || "").trim();
  const html = wrapDocxHtml(String(htmlResult.value || ""), decodeURIComponent(req.headers["x-file-name"] || "Document"));
  return json(res, {
    content,
    html,
    warnings: [...(htmlResult.messages || []), ...(textResult.messages || [])].map((message) => String(message.message || message)).slice(0, 8),
  });
}


async function chat(req, res) {
  const session = readSession(req);
  const body = await readJson(req, 50 * 1024 * 1024);
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-100) : [];
  const chatThreadId = body?.threadId || null; // for persisting artifacts to SQLite
  // 流畅模式：同一套 harness（工具/视觉/附件/记忆全在），只把 LLM 调用切到 DeepSeek。
  // 用 AsyncLocalStorage 设请求级 provider，主循环与 callHaiku 都读它。
  if (body?.mode === "fast" && deepseekApiKey) {
    reqCtx.enterWith({ provider: deepseekProvider() });
  }
  // Build per-user system prompt with long-term memory
  const userMemory = session ? dbMemory.get(session.userId) : "";
  const systemPrompt = buildSystemPrompt(userMemory);
  // Preprocess: extract text from binary file attachments (PDF, XLSX)
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (part?.type === "pdf_url" && part.pdf_url?.url) {
        const pdfText = await extractPdfText(part.pdf_url.url, part.pdf_url.name);
        msg.content[i] = { type: "text", text: pdfText };
      } else if (part?.type === "file_url" && part.file_url?.url) {
        const fileText = await extractFileText(part.file_url.url, part.file_url.name);
        msg.content[i] = { type: "text", text: fileText };
      }
    }
  }
  const temperature = Number.isFinite(body?.temperature) ? body.temperature : 0.7;

  // Convert frontend messages to Anthropic format
  let apiMessages = toAnthropicMessages(messages);

  // Haiku summarization stats (tracked across this request)
  const haikuStats = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let compressFromTokens = 0, compressToTokens = 0;

  // Proactive compress before first API call (avoids waiting for 400)
  {
    const preTokens = estimateTokens(apiMessages);
    if (preTokens > PROACTIVE_TOKEN_BUDGET) {
      compressFromTokens = preTokens;
      const result = await proactiveCompress(apiMessages, PROACTIVE_TOKEN_BUDGET, haikuStats);
      apiMessages = result.messages;
      compressToTokens = result.toTokens;
      console.log(`[Chat] Proactive compress: ${compressFromTokens} -> ${compressToTokens} tokens (${haikuStats.calls} Haiku calls)`);
    }
    // Hard cap fallback: if still over HARD_CAP after compression, truncate from tail
    if (estimateTokens(apiMessages) > HARD_CAP) {
      apiMessages = takeByBudget(apiMessages, HARD_CAP);
      console.log(`[Chat] Hard cap applied: truncated to ~${HARD_CAP} tokens`);
    }
  }

  // Build available tools
  const tools = anthropicTools.filter((t) => {
    if (t.name === "web_search") return webSearchEnabled && braveApiKey;
    return true;
  });

  // Start SSE response to frontend
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  res.write(": stream\n\n");

  const MAX_ROUNDS = 12;
  const chatStartTime = Date.now();
  const collectedToolCalls = [];
  const P = llmProvider(); // 当前请求的 LLM provider（默认 Anthropic / 流畅模式 = DeepSeek）

  const TOKEN_BUDGET = IN_LOOP_TOKEN_BUDGET;
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheCreationTokens = 0, totalCacheReadTokens = 0;
  let totalRounds = 0;
  let pptxVizFails = 0; // make_pptx 视觉判官不过的次数（每请求）；到上限后即便没过也交付，杜绝无限重改
  const PPTX_MAX_VIZ_RETRIES = 2;

  try {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    totalRounds = round + 1;
    console.log(`[Chat] Round ${round} start, messages: ${apiMessages.length}, est tokens: ${estimateTokens(apiMessages)}`);
    const isLastRound = round === MAX_ROUNDS - 1;
    // Proactive context management: compress if approaching budget
    if (round > 0) {
      apiMessages = budgetCompress(apiMessages, TOKEN_BUDGET);
    }
    // Search allowed in first 3 rounds, fetch_url in first 5
    const roundTools = round < 3
      ? tools
      : round < 5
        ? tools.filter((t) => t.name !== "web_search")
        : tools.filter((t) => t.name !== "web_search" && t.name !== "fetch_url");

    const upstreamBody = {
      model: P.mainModel,
      max_tokens: 32768,
      stream: true,
      temperature,
      system: systemPrompt,
      messages: apiMessages,
      ...(!isLastRound && roundTools.length ? { tools: roundTools } : {}),
    };

    console.log(`[Chat] Round ${round}: sending to ${P.isDeepSeek ? "DeepSeek" : "Anthropic"} (${P.mainModel}), body size: ${JSON.stringify(upstreamBody).length} chars`);
    const upstream = await fetch(P.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": P.isDeepSeek ? P.apiKey : apiKey,
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify(upstreamBody),
    });
    console.log(`[Chat] Round ${round}: API responded ${upstream.status}`);

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      // On 400, wait briefly then retry (handles both rate limits and context size)
      if (upstream.status === 400) {
        await delay(1500);
        const compressedMessages = round === 0 ? apiMessages : compressMessages(apiMessages);
        const retryBody = {
          model: P.mainModel, max_tokens: 32768, stream: true, temperature,
          system: systemPrompt,
          messages: compressedMessages,
          tools: tools.length ? tools : undefined,
        };
        const retry = await fetch(P.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": P.isDeepSeek ? P.apiKey : apiKey, "anthropic-version": "2024-10-22", "anthropic-beta": "prompt-caching-2024-07-31" },
          body: JSON.stringify(retryBody),
        });
        if (retry.ok && retry.body) {
          const retryResult = await consumeAnthropicStream(retry.body, res);
          // Handle tool calls from retry (mainly create_artifact)
          if (retryResult.stopReason === "tool_use" && retryResult.toolUseBlocks.length) {
            for (const tc of retryResult.toolUseBlocks) {
              res.write(`event: tool_start\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, args: toolDisplayArgs(tc.name, tc.input) })}\n\n`);
              console.log(`[Chat] Executing tool: ${tc.name}`);
              collectedToolCalls.push(tc.name);
        const toolResult = await executeTool(tc.name, tc.input, res, chatThreadId, session?.userId || null);
              if (tc.name === "create_artifact") {
                const retryContent = String(tc.input.content || "");
                if (retryContent.trim().length >= 20) {
                  const artifactDoc = { title: tc.input.title || "Artifact", type: tc.input.type || "html", content: retryContent, language: tc.input.language || "", description: tc.input.description || "", file_path: tc.input.file_path || "" };
                  if (chatThreadId) { try { dbDocuments.upsert(chatThreadId, { id: crypto.randomUUID(), ...artifactDoc }); } catch {} }
                  try { res.write(`event: artifact\ndata: ${JSON.stringify(artifactDoc)}\n\n`); } catch {}
                } else {
                  console.warn(`[Chat] Retry create_artifact rejected for "${tc.input.title}": content too short (${retryContent.trim().length} chars)`);
                }
              }
              res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, summary: toolResult.summary, sources: toolResult.sources || undefined })}\n\n`);
              res.flush?.();
            }
          }
          break;
        }
      }
      res.write(`data: ${JSON.stringify({ delta: `请求失败 (${upstream.status})：${errText.slice(0, 200)}` })}\n\n`);
      break;
    }

    const result = await consumeAnthropicStream(upstream.body, res);
    // Normalize: if stopReason is empty/missing, infer from content
    if (!result.stopReason) {
      result.stopReason = result.toolUseBlocks?.length ? "tool_use" : "end_turn";
      console.log(`[Chat] Round ${round}: stopReason was empty, inferred as ${result.stopReason}`);
    }
    totalInputTokens += result.inputTokens || 0;
    totalOutputTokens += result.outputTokens || 0;
    totalCacheCreationTokens += result.cacheCreationTokens || 0;
    totalCacheReadTokens += result.cacheReadTokens || 0;
    console.log(`[Chat] Round ${round}: stream consumed, stopReason=${result.stopReason}, toolUse=${result.toolUseBlocks?.length || 0}, tokens: +${result.inputTokens}/${result.outputTokens}, cache: creation=${result.cacheCreationTokens || 0} read=${result.cacheReadTokens || 0}`);

    if (result.stopReason === "tool_use" && result.toolUseBlocks.length) {
      const allSearches = result.toolUseBlocks.every((t) => t.name === "web_search");
      // Add assistant tool_use blocks (required for non-search tool calls)
      if (!allSearches) {
        // Trim any huge text blocks in allBlocks to avoid context bloat
        const trimmedBlocks = result.allBlocks.map(b => {
          if (b.type === "text" && b.text && b.text.length > 5000) {
            return { ...b, text: b.text.slice(0, 5000) + "..." };
          }
          return b;
        });
        apiMessages.push({ role: "assistant", content: trimmedBlocks });
      }

      // Execute tools and build tool_result blocks
      const toolResultBlocks = [];
      let hasArtifact = false;
      let docGenerated = false; // set when generate_long_document or run_code doc files complete
      for (const tc of result.toolUseBlocks) {
        collectedToolCalls.push(tc.name);
        res.write(`event: tool_start\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, args: toolDisplayArgs(tc.name, tc.input) })}\n\n`);
        res.flush?.();

        const toolResult = await executeTool(tc.name, tc.input, res, chatThreadId, session?.userId || null);

        if (tc.name === "create_artifact") {
          if (toolResult.error) {
            // Content rejected (empty/too short) — skip persisting and emitting
            console.warn(`[Chat] create_artifact rejected for "${tc.input.title}": content too short (${String(tc.input.content || "").trim().length} chars)`);
          } else {
            hasArtifact = true;
            const artifactDoc = {
              title: tc.input.title || "Artifact",
              type: tc.input.type || "html",
              content: tc.input.content || "",
              language: tc.input.language || "",
              description: tc.input.description || "",
              file_path: tc.input.file_path || "",
            };
            // Persist to SQLite immediately (survives client disconnect)
            if (chatThreadId) {
              try {
                const docId = crypto.randomUUID();
                dbDocuments.upsert(chatThreadId, { id: docId, ...artifactDoc });
              } catch (e) { console.error("[Chat] Failed to persist artifact:", e.message); }
            }
            try {
              res.write(`event: artifact\ndata: ${JSON.stringify(artifactDoc)}\n\n`);
              res.flush?.();
            } catch {}
          }
        }

        // generate_long_document emits its own artifact event inside executeTool; mark done
        if (tc.name === "generate_long_document") {
          docGenerated = true;
        }

        // Emit generated files as file-type artifacts for document panel
        if ((tc.name === "run_code" || tc.name === "make_pptx") && toolResult.codeResult?.files?.length) {
          for (const f of toolResult.codeResult.files) {
            const ext = f.name.split(".").pop().toLowerCase();
            const artifactDoc = {
              title: f.name,
              type: "file",
              content: "",
              language: ext,
              description: `${ext.toUpperCase()} 文件 · ${f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + " MB" : Math.round(f.size / 1024) + " KB"}`,
              file_path: f.name,
              fileId: f.id,
              fileSize: f.size,
              // PPTX：随文件带上逐页预览图（make_pptx 渲染 QA 时已产出），前端在文档面板内联展示
              previewImages: ext === "pptx" && toolResult.codeResult.preview?.length ? toolResult.codeResult.preview : undefined,
            };
            if (chatThreadId) {
              try { dbDocuments.upsert(chatThreadId, { id: crypto.randomUUID(), ...artifactDoc }); } catch {}
            }
            try { res.write(`event: artifact\ndata: ${JSON.stringify(artifactDoc)}\n\n`); res.flush?.(); } catch {}
          }
          // If run_code produced downloadable doc files, mark done so AI won't re-generate HTML
          if (toolResult.codeResult.files.some(f => /\.(docx|xlsx|pptx|pdf)$/i.test(f.name))) {
            // make_pptx 视觉判官未过：文件已作为 best-effort 交付（上方 artifact 已 emit），
            // 但允许模型最多再改 PPTX_MAX_VIZ_RETRIES 次；到上限则收手交付，避免反复重写 17 分钟一场空。
            if (tc.name === "make_pptx" && toolResult.codeResult.pass === false && pptxVizFails < PPTX_MAX_VIZ_RETRIES) {
              pptxVizFails++;
              console.log(`[Chat] make_pptx viz QA failed, best-effort delivered; allowing retry ${pptxVizFails}/${PPTX_MAX_VIZ_RETRIES}`);
            } else {
              docGenerated = true;
            }
          }
        }

        res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, summary: toolResult.summary, sources: toolResult.sources || undefined, codeResult: toolResult.codeResult || undefined })}\n\n`);
        res.flush?.();

        // Cap tool result content to prevent context explosion
        const maxResultLen = tc.name === "web_search" ? 12000
          : tc.name === "fetch_url" ? 10000
          : tc.name === "run_code" ? 5000
          : 3000;
        const resultContent = typeof toolResult.content === "string"
          ? toolResult.content.slice(0, maxResultLen)
          : toolResult.content;
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: resultContent,
        });
      }

      // Document/file generation complete — break the loop so the AI doesn't
      // generate a follow-up turn with options or a redundant HTML preview.
      if (docGenerated) break;

      // Compact approach: avoid carrying huge content into next round
      if (hasArtifact) {
        // Compress: replace the full assistant tool_use blocks with a summary
        // so artifact content doesn't bloat the context
        const artifactNames = result.toolUseBlocks
          .filter((t) => t.name === "create_artifact")
          .map((t) => t.input?.title || "Artifact");
        apiMessages.pop(); // remove the verbose assistant content we just pushed
        apiMessages.push({ role: "assistant", content: `已创建文档：${artifactNames.join("、")}。` });
        apiMessages.push({ role: "user", content: "文档已生成。如果还有其他需要补充说明的内容或建议，请简要说明。" });
      } else if (allSearches && toolResultBlocks.length) {
        // Keep meaningful content from each search for the next round
        const searchSummary = toolResultBlocks
          .map((b) => String(b.content || "").slice(0, 4000))
          .filter(Boolean)
          .join("\n\n---\n\n");
        console.log(`[Chat] allSearches branch: ${toolResultBlocks.length} results, summary ${searchSummary.length} chars`);
        apiMessages.push({ role: "assistant", content: `我搜索了相关信息，以下是搜索结果摘要：\n\n${searchSummary.slice(0, 12000)}` });
        apiMessages.push({ role: "user", content: "请仔细阅读以上搜索结果和全文内容。如果信息已经足够回答问题，请直接给出深入全面的回答。如果某个方面信息不足，可以用 fetch_url 深入阅读某篇文章，或换角度再搜一次。不要重复搜索已有信息。" });
      } else {
        console.log(`[Chat] Non-search tool results: ${toolResultBlocks.length} blocks`);
        apiMessages.push({ role: "user", content: toolResultBlocks });
      }
      continue; // Next round
    }

    // No tool calls — check if model intended to use a tool but stream was cut short
    if (result.textContent && !result.toolUseBlocks?.length && round < MAX_ROUNDS - 1) {
      const text = result.textContent.slice(-200);
      const wantsArtifact = /生成|创建|整理成|输出|写一份|制作/.test(text) && /报告|文档|方案|调研|表格|artifact/i.test(text);
      if (wantsArtifact) {
        console.log(`[Chat] Round ${round}: detected unfinished artifact intent, auto-continuing`);
        apiMessages.push({ role: "assistant", content: result.textContent });
        apiMessages.push({ role: "user", content: "请继续，使用 create_artifact 工具生成完整内容。" });
        continue;
      }
    }
    break;
  }

  } catch (loopErr) {
    console.error("[Chat] Agentic loop error:", loopErr.message, "\n", loopErr.stack);
    try {
      res.write(`data: ${JSON.stringify({ delta: `\n\n---\n请求出错：${String(loopErr.message).slice(0, 200)}` })}\n\n`);
    } catch {}
  }
  // Record usage + telemetry
  const latencyMs = Date.now() - chatStartTime;
  if (totalInputTokens || totalOutputTokens) {
    if (session) {
      try {
        dbUsage.record(session.userId, totalInputTokens, totalOutputTokens, model);
      } catch (e) { console.error("[Usage] Failed to record:", e.message); }
    }
    console.log(`[Chat] Total tokens: input=${totalInputTokens}, output=${totalOutputTokens}`);
  }
  // Telemetry: record tool calls, latency, message preview
  try {
    const lastUserMsg = messages.findLast(m => m.role === "user");
    const preview = typeof lastUserMsg?.content === "string" ? lastUserMsg.content.slice(0, 2000) : "";
    dbTelemetry.record(session?.userId || "", chatThreadId || "", collectedToolCalls, totalInputTokens, totalOutputTokens, latencyMs, preview, P.mainModel, totalRounds, totalCacheCreationTokens, totalCacheReadTokens, compressFromTokens, compressToTokens, haikuStats.calls, haikuStats.inputTokens, haikuStats.outputTokens);
  } catch (e) { console.error("[Telemetry] Failed to record:", e.message); }
  try {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  } catch {}
}

// ---------------------------------------------------------------------------
// Convert frontend messages (OpenAI-ish) to Anthropic Messages API format
// ---------------------------------------------------------------------------
function toAnthropicMessages(messages) {
  const result = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = toAnthropicContent(msg.content, role);
    // Anthropic requires alternating user/assistant — merge consecutive same-role
    if (result.length && result.at(-1).role === role) {
      const prev = result.at(-1);
      prev.content = Array.isArray(prev.content)
        ? [...prev.content, ...(Array.isArray(content) ? content : [{ type: "text", text: content }])]
        : [{ type: "text", text: prev.content }, ...(Array.isArray(content) ? content : [{ type: "text", text: content }])];
    } else {
      result.push({ role, content });
    }
  }
  return result;
}

function toAnthropicContent(content, role) {
  if (!Array.isArray(content)) return String(content || "").slice(0, 120000);
  const blocks = [];
  for (const part of content) {
    if (part?.type === "pdf_url") console.log("[PDF] found pdf_url part, name:", part.pdf_url?.name, "url length:", (part.pdf_url?.url || "").length);
    if (part?.type === "image_url") {
      const url = part.image_url?.url || (typeof part.image_url === "string" ? part.image_url : "");
      const parsed = parseDataImage(url);
      if (parsed) {
        blocks.push({ type: "image", source: parsed });
      } else if (url) {
        // Fallback: if data URL parsing failed, tell the model an image was attached
        blocks.push({ type: "text", text: "[用户上传了一张图片，但解析失败]" });
      }
    } else if (part?.type === "pdf_url") {
      // PDF should already be preprocessed to text in chat(); fallback just in case
      blocks.push({ type: "text", text: "[PDF attachment - content not extracted]" });
    } else if (part?.type === "file_url") {
      blocks.push({ type: "text", text: "[File attachment - content not extracted]" });
    } else {
      const text = String(part?.text || "").slice(0, 120000);
      if (text) blocks.push({ type: "text", text });
    }
  }
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

// ---------------------------------------------------------------------------
// Anthropic streaming parser — forwards text deltas to client, accumulates
// tool_use blocks, returns everything when the stream ends.
// ---------------------------------------------------------------------------
async function consumeAnthropicStream(body, res) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textContent = "";
  const allBlocks = [];     // complete content blocks for context
  let currentBlock = null;
  let stopReason = "";
  let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;

      try {
        const data = JSON.parse(raw);

        switch (eventType) {
          case "content_block_start":
            currentBlock = { ...data.content_block };
            if (currentBlock.type === "tool_use") {
              currentBlock._inputJson = "";
            }
            break;

          case "content_block_delta":
            if (data.delta?.type === "text_delta" && data.delta.text) {
              textContent += data.delta.text;
              if (currentBlock) currentBlock.text = (currentBlock.text || "") + data.delta.text;
              res.write(`data: ${JSON.stringify({ delta: data.delta.text })}\n\n`);
              res.flush?.();
            }
            if (data.delta?.type === "input_json_delta" && data.delta.partial_json != null) {
              if (currentBlock) currentBlock._inputJson = (currentBlock._inputJson || "") + data.delta.partial_json;
            }
            break;

          case "content_block_stop":
            if (currentBlock) {
              if (currentBlock.type === "tool_use") {
                currentBlock.input = safeParseJson(currentBlock._inputJson);
                delete currentBlock._inputJson;
              }
              allBlocks.push(currentBlock);
              currentBlock = null;
            }
            break;

          case "message_start":
            if (data.message?.usage) {
              inputTokens += data.message.usage.input_tokens || 0;
              cacheCreationTokens += data.message.usage.cache_creation_input_tokens || 0;
              cacheReadTokens += data.message.usage.cache_read_input_tokens || 0;
            }
            break;

          case "message_delta":
            if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
            if (data.usage) {
              if (data.usage.output_tokens) outputTokens = data.usage.output_tokens;
              if (data.usage.input_tokens) inputTokens = data.usage.input_tokens;
            }
            break;
        }
      } catch {
        // Ignore malformed
      }
    }
  }

  return {
    textContent,
    allBlocks: allBlocks.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text || "" };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      return b;
    }),
    toolUseBlocks: allBlocks.filter((b) => b.type === "tool_use"),
    stopReason,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  };
}

// ---------------------------------------------------------------------------
// Tool execution dispatcher
// ---------------------------------------------------------------------------
async function executeTool(name, args, res = null, threadId = null, userId = null) {
  switch (name) {
    case "web_search": {
      const query = String(args?.query || "").trim();
      if (!query) return { summary: "空查询", content: "No query provided.", sources: [] };

      // Smart multi-engine search with fallback chain
      const results = await multiSearch(query);
      if (!results.length) return { summary: "无结果", content: `No search results found for: ${query}`, sources: [] };

      // Inline-content-first (claude.ai-style): if snippets are already rich, skip fetch;
      // else selectively retrieve only the top-N (default 1) — fetch+extract is the exception.
      const fetchable = results.filter(r => r.url && r.url.startsWith("http"));
      const inlineChars = results.reduce((n, r) => n + (r.description?.length || 0), 0);
      const fetchCount = inlineChars >= inlineRichChars ? 0 : Math.min(autoFetchN, fetchable.length);
      const fetchPromises = fetchCount
        ? fetchable.slice(0, fetchCount).map(r => fetchPageText(r.url, 6000, query).catch(() => ""))
        : [];
      const fullTexts = await Promise.all(fetchPromises);

      // Build rich output
      let fetchIdx = 0;
      const formatted = results
        .map((r, i) => {
          let entry = `[${i + 1}] ${r.title}${r.age ? ` (${r.age})` : ""}`;
          if (r.url) entry += `\nURL: ${r.url}`;
          entry += `\n${r.description}`;
          if (r.url && fetchIdx < fetchCount && fetchable[fetchIdx]?.url === r.url) {
            if (fullTexts[fetchIdx]) {
              entry += `\n--- 页面内容 ---\n${fullTexts[fetchIdx]}`;
            }
            fetchIdx++;
          }
          return entry;
        })
        .join("\n\n");

      const sources = results.filter(r => r.url).map((r) => ({ title: r.title, url: r.url, snippet: r.description.slice(0, 180) }));
      const fetchedCount = fullTexts.filter(Boolean).length;
      return { summary: `${results.length} 条结果${fetchedCount ? ` (已读取 ${fetchedCount} 篇全文)` : ""}`, content: formatted.slice(0, 15000), sources };
    }
    case "fetch_url": {
      const url = String(args?.url || "").trim();
      if (!url) return { summary: "空 URL", content: "No URL provided." };
      const goal = String(args?.goal || "").trim();
      try {
        // Robust chain (plain → Jina → Firecrawl → Exa), then keep only goal-relevant content
        const text = await fetchPageText(url, 12000, goal);
        if (!text) return { summary: "抓取失败", content: `Failed to fetch readable content from: ${url}` };
        return { summary: url.slice(0, 40), content: `[${url}]\n\n${text}` };
      } catch (e) {
        return { summary: "抓取失败", content: `Fetch error: ${e.message}` };
      }
    }
    case "run_code": {
      const lang = String(args?.language || "javascript");
      const code = String(args?.code || "");
      if (!code.trim()) return { summary: "空代码", content: "No code provided." };
      try {
        const result = await executeCode(lang, code);
        return { summary: result.error ? "执行出错" : "执行完成", content: result.output.slice(0, 4000), codeResult: result };
      } catch (e) {
        return { summary: "执行���败", content: `Error: ${e.message}` };
      }
    }
    case "generate_image": {
      const prompt = String(args?.prompt || "").trim();
      if (!prompt) return { summary: "空 prompt", content: "No prompt provided." };
      const size = String(args?.size || "1536x1024");
      const r = await generateImage(prompt, size);
      if (r.error) return { summary: "生图失败", content: `图像生成失败：${r.message}`, error: true };
      // content（进模型上下文）只给路径，绝不放 base64；dataUrl 走 codeResult.images 仅供前端内联展示。
      return {
        summary: "图像已生成",
        content: `图像已生成并保存到：${r.path}\n尺寸：${r.size}。要把它放进 PPT，在 run_code 里用 pptxgenjs：slide.addImage({ path: "${r.path}", x, y, w, h })。`,
        codeResult: { output: "(图像已生成)", images: [r.dataUrl], files: [] },
      };
    }
    case "make_pptx": {
      const code = String(args?.code || "");
      if (!code.trim()) return { summary: "空代码", content: "No pptxgenjs code provided." };
      const fileName = String(args?.fileName || "presentation.pptx").replace(/[^\w.\-一-鿿]/g, "_");
      try {
        const r = await makePptx(code, /\.pptx$/i.test(fileName) ? fileName : fileName + ".pptx");
        return {
          summary: r.pass ? (r.degraded ? "PPT 已生成(QA 跳过)" : "PPT 已生成·QA 通过") : "QA 未过·需修正",
          content: r.content.slice(0, 4000),
          codeResult: { output: r.pass ? "(PPT 已生成)" : "(QA 未通过)", images: [], files: r.files || [], preview: r.preview || [], pass: r.pass },
        };
      } catch (e) {
        return { summary: "make_pptx 出错", content: `make_pptx 执行异常：${e.message}` };
      }
    }
    case "generate_long_document": {
      const topic = String(args?.topic || "").trim();
      if (!topic) return { summary: "空主题", content: "No topic provided." };
      const result = await executeGenerateLongDoc(args, res);
      return result;
    }
    case "create_artifact": {
      const title = String(args?.title || "Artifact").slice(0, 50);
      const content = String(args?.content || "");
      if (content.trim().length < 20) {
        return {
          summary: `内容过短，已拒绝写入`,
          content: `Error: artifact content is empty or too short (${content.trim().length} chars, minimum 20 required). Please provide complete content and call create_artifact again.`,
          error: true,
        };
      }
      return {
        summary: `已创建「${title}」`,
        content: `Artifact "${title}" has been created and is now visible in the user's preview panel.`,
      };
    }
    case "list_artifacts": {
      if (!threadId) return { summary: "无可用对话", content: "No thread ID available. This tool can only be used within an active conversation." };
      const docs = dbDocuments.list(threadId);
      if (!docs.length) return { summary: "无已保存文档", content: "No artifacts found in this thread." };
      const list = docs.map(d => `- ID: ${d.id}\n  标题: ${d.title}\n  类型: ${d.type}\n  更新时间: ${d.updated_at}`).join("\n\n");
      return { summary: `${docs.length} 个文档`, content: `当前对话已保存的文档（共 ${docs.length} 个）：\n\n${list}` };
    }
    case "get_artifact": {
      const artId = String(args?.id || "").trim();
      if (!artId) return { summary: "缺少 ID", content: "No artifact ID provided." };
      const doc = dbDocuments.get(artId);
      if (!doc) return { summary: "未找到", content: `Artifact with ID "${artId}" not found.` };
      return { summary: `「${doc.title}」`, content: `标题: ${doc.title}\n类型: ${doc.type}\n更新时间: ${doc.updated_at}\n\n${doc.content}` };
    }
    case "manage_memory": {
      const action = String(args?.action || "read");
      if (!userId) return { summary: "无法操作记忆", content: "No user session available." };
      if (action === "read") {
        const mem = dbMemory.get(userId);
        return { summary: "已读取记忆", content: mem || "（暂无记忆）" };
      }
      if (action === "append") {
        const line = String(args?.content || "").trim();
        if (!line) return { summary: "内容为空", content: "No content to append." };
        dbMemory.append(userId, line);
        return { summary: "已追加到记忆", content: `已追加：${line}` };
      }
      if (action === "replace") {
        const content = String(args?.content || "");
        dbMemory.replace(userId, content);
        return { summary: "记忆已更新", content: `记忆已全量替换，长度：${content.length} 字符` };
      }
      return { summary: "未知操作", content: `Unknown action: ${action}` };
    }
    default:
      return { summary: "未知工具", content: `Unknown tool: ${name}` };
  }
}

// Compress messages for retry after 400 — flatten tool exchanges into a single user summary
// Estimate token count (rough: 1 token ≈ 3.5 chars for mixed zh/en)
function estimateTokens(messages) {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") chars += (block.text || "").length;
        else if (block.type === "tool_use") chars += JSON.stringify(block.input || {}).length;
        else if (block.type === "tool_result") chars += (typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")).length;
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

// Progressively compress messages to fit within token budget
function budgetCompress(messages, maxTokens) {
  let est = estimateTokens(messages);
  if (est <= maxTokens) return messages;

  // Strategy 1: Truncate long tool_result content (keep first 2000 chars)
  const compressed = JSON.parse(JSON.stringify(messages)); // deep clone
  for (let i = 0; i < compressed.length - 2; i++) {
    const msg = compressed[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 2000) {
          block.content = block.content.slice(0, 2000) + "\n...(内容已截断)";
        }
      }
    }
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 3000) {
      // Truncate long assistant search summaries from earlier rounds
      msg.content = msg.content.slice(0, 3000) + "\n...(已截断)";
    }
  }
  est = estimateTokens(compressed);
  if (est <= maxTokens) return compressed;

  // Strategy 2: Drop early tool rounds entirely, keep summary
  return compressMessages(compressed);
}

function compressMessages(messages) {
  const compressed = [];
  let toolSummary = "";

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Extract text parts, summarize tool_use parts
      const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const toolParts = msg.content.filter((b) => b.type === "tool_use").map((b) => `[已调用 ${b.name}]`).join(" ");
      if (textParts || toolParts) {
        toolSummary += (textParts ? textParts + " " : "") + toolParts + "\n";
      }
    } else if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result")) {
      // Summarize tool results
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content = String(block.content || "").slice(0, 400);
          toolSummary += `[工具结果]: ${content}\n`;
        }
      }
    } else {
      // Regular message — if we have accumulated tool summary, inject it first
      if (toolSummary) {
        compressed.push({ role: "assistant", content: toolSummary.trim() });
        toolSummary = "";
      }
      compressed.push(msg);
    }
  }

  // If trailing tool summary, add as assistant message + clear instruction
  if (toolSummary) {
    compressed.push({ role: "assistant", content: toolSummary.trim() });
    compressed.push({ role: "user", content: "请基于以上搜索结果，使用 create_artifact 工具完成我最初的请求。生成完整的、高质量的内容。" });
  }

  return compressed;
}

// Select messages from tail until token budget is exhausted (replaces hard slice(-24))
function takeByBudget(messages, budget) {
  if (!messages?.length) return [];
  const result = [];
  let usedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = msg.content || "";
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map(p => typeof p === "string" ? p : (p.text || p.content || "")).join("")
      : "";
    const tokens = Math.ceil(text.length / 3.5);
    if (usedTokens + tokens > budget && result.length > 0) break;
    result.unshift(msg);
    usedTokens += tokens;
  }
  return result;
}

// Haiku-role call for internal summarization/extraction tasks.
// Follows the per-request provider: Anthropic Haiku (key pool) by default,
// DeepSeek flash in 流畅模式 — so search/compress never falls back to Claude.
// callHaiku / summarizeWithHaiku / extractRelevant / callClaude moved to lib/llm.mjs.

// Proactive context compression: L1 Haiku summarize → L2 budgetCompress fallback
async function proactiveCompress(messages, budget, haikuStats) {
  const fromTokens = estimateTokens(messages);
  if (fromTokens <= budget) return { messages, fromTokens, toTokens: fromTokens };

  const compressed = JSON.parse(JSON.stringify(messages));
  const haikuCallsBefore = haikuStats.calls;

  // L1: Summarize large tool_results with Haiku (skip last 2 messages)
  const TOOL_RESULT_THRESHOLD = 3000;
  let l1Count = 0;
  for (let i = 0; i < compressed.length - 2; i++) {
    const msg = compressed[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > TOOL_RESULT_THRESHOLD) {
        const origLen = block.content.length;
        try {
          block.content = await summarizeWithHaiku(block.content, haikuStats);
          l1Count++;
        } catch (e) {
          console.warn("[Compress] Haiku summarize failed, truncating:", e.message);
          block.content = block.content.slice(0, TOOL_RESULT_THRESHOLD) + "\n...(已截断)";
        }
        console.log(`[Compress L1] tool_result[${i}] ${origLen}chars -> ${block.content.length}chars`);
      }
    }
  }

  const afterL1 = estimateTokens(compressed);
  const haikuCallsL1 = haikuStats.calls - haikuCallsBefore;
  console.log(`[Compress L1] ${l1Count} tool_results processed, ${haikuCallsL1} Haiku calls, ${fromTokens} -> ${afterL1} tokens`);
  if (afterL1 <= budget) return { messages: compressed, fromTokens, toTokens: afterL1 };

  // L2+: Fall back to existing budget compress (truncation + structural flatten)
  console.log(`[Compress L2] ${afterL1} tokens still > budget ${budget}, falling back to budgetCompress`);
  const final = budgetCompress(compressed, budget);
  const toTokens = estimateTokens(final);
  console.log(`[Compress L2] ${afterL1} -> ${toTokens} tokens`);
  return { messages: final, fromTokens, toTokens };
}

function toolDisplayArgs(name, args) {
  if (name === "web_search") return { query: args?.query };
  if (name === "fetch_url") return { url: args?.url };
  if (name === "run_code") return { language: args?.language, code: String(args?.code || "").slice(0, 80) };
  if (name === "generate_long_document") return { topic: args?.topic, pages: args?.pages };
  if (name === "create_artifact") return { title: args?.title, type: args?.type };
  if (name === "list_artifacts") return {};
  if (name === "get_artifact") return { id: args?.id };
  if (name === "manage_memory") return { action: args?.action, content: String(args?.content || "").slice(0, 60) };
  return {};
}

// Multi-engine search + robust page fetch moved to tools/web.mjs.


function contentToText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return String(content || "");
}

function normalizeMessageContent(content) {
  if (!Array.isArray(content)) return String(content || "").slice(0, 120000);
  return content
    .map((part) => {
      if (part?.type === "image_url" && part.image_url?.url) {
        return { type: "image_url", image_url: String(part.image_url.url).slice(0, 7_500_000) };
      }
      if (part?.type === "image_url" && typeof part.image_url === "string") {
        return { type: "image_url", image_url: part.image_url.slice(0, 7_500_000) };
      }
      if (part?.type === "pdf_url" && part.pdf_url?.url) {
        return { type: "pdf_url", pdf_url: { url: part.pdf_url.url, name: part.pdf_url.name || "document.pdf" } };
      }
      return { type: "text", text: String(part?.text || "").slice(0, 120000) };
    })
    .filter((part) => part.type === "image" || part.type === "image_url" || part.type === "pdf_url" || part.text);
}

async function extractFileText(dataUrl, name) {
  try {
    const match = String(dataUrl).match(/^data:[^;]+;base64,(.+)$/i);
    if (!match) return `[文件: ${name || "file"} - 无法解析]`;
    const buffer = Buffer.from(match[1], "base64");
    const lower = (name || "").toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map(sn => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sn], { blankrows: false });
        return `[Sheet: ${sn}]\n${csv}`;
      });
      const text = sheets.join("\n\n").slice(0, 100000);
      return `[Excel 文件: ${name}, ${workbook.SheetNames.length} 个工作表]\n\n${text}`;
    }
    return `[文件: ${name} - 不支持的格式]`;
  } catch (e) {
    console.error("[FILE] extraction error:", e.message);
    return `[文件: ${name || "file"} - 提取失败: ${e.message}]`;
  }
}

async function extractPdfText(dataUrl, name) {
  try {
    const match = String(dataUrl).match(/^data:application\/pdf;base64,(.+)$/i);
    if (!match) return `[PDF: ${name || "document.pdf"} - 无法解析]`;
    const buffer = Buffer.from(match[1], "base64");
    const result = await pdfParse(buffer);
    const text = (result.text || "").trim().slice(0, 100000);
    if (!text) return `[PDF: ${name || "document.pdf"} - 无文本内容（可能是扫描件）]`;
    return `[PDF 文件: ${name || "document.pdf"}, ${result.numpages} 页]\n\n${text}`;
  } catch (e) {
    console.error("[PDF] extraction error:", e.message);
    return `[PDF: ${name || "document.pdf"} - 提取失败: ${e.message}]`;
  }
}

function parseDataPdf(url) {
  const str = String(url || "").trim();
  const headerMatch = str.match(/^data:application\/pdf;base64,/i);
  if (!headerMatch) return null;
  const data = str.slice(headerMatch[0].length).replace(/[\s\r\n]/g, "");
  if (!data) return null;
  return {
    type: "base64",
    media_type: "application/pdf",
    data,
  };
}

function parseDataImage(url) {
  const str = String(url || "").trim();
  // Accept common image formats including those converted by canvas
  const headerMatch = str.match(/^data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif|svg\+xml));base64,/i);
  if (!headerMatch) return null;
  const data = str.slice(headerMatch[0].length).replace(/[\s\r\n]/g, "").slice(0, 7_500_000);
  if (!data) return null;
  // Normalize media type for Anthropic API (only supports png, jpeg, webp, gif)
  let mediaType = headerMatch[1].toLowerCase().replace("image/jpg", "image/jpeg");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
    mediaType = "image/jpeg"; // Canvas converts unsupported formats to jpeg
  }
  return {
    type: "base64",
    media_type: mediaType,
    data,
  };
}

async function staticFile(requestPath, res) {
  const cleanPath = decodeURIComponent(requestPath.split("?")[0]);
  const relative = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(publicDir)) return notFound(res);

  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return staticFile(path.join(cleanPath, "index.html"), res);
    const ext = path.extname(target);
    const cacheControl = [".html", ".js", ".css", ".svg", ".webmanifest"].includes(ext) ? "no-cache" : "public, max-age=3600";
    const headers = {
      "content-type": mime[ext] || "application/octet-stream",
      "cache-control": cacheControl,
    };
    if (cleanPath === "/sw.js") {
      headers["service-worker-allowed"] = "/";
    }
    res.writeHead(200, headers);
    const data = await fs.readFile(target);
    res.end(data);
  } catch {
    return staticFile("/", res);
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 7 * 86400_000;
  dbSessions.create(token, user.id, user.email, user.role || "user", expiresAt);
  return token;
}

function getCookieToken(req) {
  const cookie = req.headers.cookie || "";
  return cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("claude_lite="))?.slice("claude_lite=".length) || "";
}

function readSession(req) {
  const token = getCookieToken(req);
  if (!token) return null;
  const session = dbSessions.get(token);
  if (!session) return null;
  return { userId: session.user_id, email: session.email, role: session.role };
}

function isRateLimited(ip) {
  const record = loginAttempts.get(ip);
  if (!record || record.resetAt < Date.now()) return false;
  return record.count >= 10;
}

function recordAttempt(ip) {
  const record = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60_000 };
  if (record.resetAt < Date.now()) { record.count = 0; record.resetAt = Date.now() + 60_000; }
  record.count++;
  loginAttempts.set(ip, record);
}

// Cleanup expired sessions every hour
setInterval(() => {
  dbSessions.cleanup();
  const now = Date.now();
  for (const [ip, record] of loginAttempts) { if (record.resetAt < now) loginAttempts.delete(ip); }
}, 3600_000);


function wrapDocxHtml(fragment, title) {
  const body = String(fragment || "").trim() || "<p>这个文档没有可提取的正文内容。</p>";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(String(title || "Document").replace(/\.[^.]+$/, ""))}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      background: #f4efe7;
      color: #2d251d;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.72;
    }
    main {
      max-width: 820px;
      margin: 34px auto;
      border: 1px solid #e4d7c6;
      border-radius: 14px;
      background: #fffaf2;
      padding: 42px 48px;
      box-shadow: 0 12px 34px rgba(45, 37, 29, 0.08);
    }
    h1, h2, h3 { color: #2d251d; line-height: 1.24; }
    h1 { margin: 0 0 22px; padding-bottom: 12px; border-bottom: 1px solid #eadfcc; font-size: 30px; }
    h2 { margin-top: 30px; font-size: 22px; }
    h3 { margin-top: 24px; font-size: 17px; }
    p { margin: 0 0 14px; }
    .subtitle { color: #766b5f; font-size: 18px; }
    ul, ol { padding-left: 1.45em; }
    li { margin: 5px 0; }
    table { width: 100%; margin: 18px 0; border-collapse: collapse; border: 1px solid #e4d7c6; }
    th, td { border: 1px solid #e4d7c6; padding: 10px 11px; text-align: left; vertical-align: top; }
    th { background: #f3eadc; }
    blockquote { margin: 18px 0; border-left: 4px solid #bd5d3a; border-radius: 8px; background: #f8f1e8; padding: 12px 14px; color: #4e4034; }
    img { max-width: 100%; height: auto; border-radius: 8px; }
    a { color: #93482d; }
    code, pre { border-radius: 8px; background: #eee4d6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { overflow: auto; padding: 12px; }
    @media (max-width: 760px) {
      main { margin: 0; min-height: 100vh; border: 0; border-radius: 0; padding: 28px 22px; }
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}






// ---------------------------------------------------------------------------
// Export as DOCX
// ---------------------------------------------------------------------------
async function exportDocx(req, res) {
  const body = await readJson(req, 10 * 1024 * 1024);
  const title = String(body?.title || "Document");
  const markdown = String(body?.content || "");
  if (!markdown.trim()) return json(res, { error: "内容为空" }, 400);

  try {
    // Generate + validate (logs any SOTA-invariant regression; still serves the file).
    const { buffer } = await buildDocxBuffer(title, markdown);
    const filename = encodeURIComponent(safeDocFilename(title) + ".docx");
    res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      "content-length": buffer.length,
    });
    res.end(buffer);
  } catch (err) {
    console.error("[DOCX] Export error:", err);
    json(res, { error: `DOCX 生成失败: ${err.message}` }, 500);
  }
}

