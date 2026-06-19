/* pptx-qa.cjs — make_pptx 的「确定性硬卡口」层（build 时跑，零成本，先于渲染+视觉）。
 * 覆盖 track() 抓不到的：① 低对比/隐形文字（WCAG）② 装饰压字/卡片重叠 ③ 正文字号失控 ④ 越界。
 * build 时 throw → runCode 失败 → make_pptx 直接返回错误（不渲染、不调 vision）→ 模型改了重调。
 * 视觉判官仍作模型无关的兜底（catch 这层漏掉的、以及主观渲染问题）。
 * 改编自用户提供的诊断；剔掉了对我们不适用的 renderToImages（make_pptx 服务端自己渲染）。 */

const TOKENS = {
  color: { NAVY: "08263F", NAVY2: "0C3354", TEAL: "0E9488", CYAN: "22D3EE", AQUA: "5EEAD4",
    INK: "0E2436", MUTED: "5E7A8C", LIGHT: "F2F8FA", WHITE: "FFFFFF", TINT: "EAF5F6" },
  // 字号是档位不是随手填；正文超过 BODY_MAX 视为错误。
  size: { TITLE: 40, SECTION: 22, BODY: 15, BODY_MAX: 17, CAPTION: 11 },
  // 拉丁/中文字体分开：Century Schoolbook / Calibri 不含中文字形，直接 shape 汉字会 fallback 发虚。
  font: { HEAD_EN: "Century Schoolbook", BODY_EN: "Calibri", HEAD_CN: "Noto Serif CJK SC", BODY_CN: "Noto Sans CJK SC" },
};

const hasCJK = (s) => /[㐀-鿿豈-﫿぀-ヿ]/.test(String(s));
function pickFont(text, { head = false } = {}) {
  const f = TOKENS.font;
  if (hasCJK(text)) return head ? f.HEAD_CN : f.BODY_CN;
  return head ? f.HEAD_EN : f.BODY_EN;
}

/* ---- 对比度：颜色属于 (元素 + 背景) 组合，不属于元素本身 ---- */
function _lum(hex) {
  const h = String(hex).replace("#", "");
  const c = [0, 2, 4].map((i) => {
    let v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(fg, bg) {
  const a = _lum(fg), b = _lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
// 给定背景，自动返回对比度更高的墨黑或纯白——模型不用再「记得」配对。
function textOn(bg) {
  return contrast(TOKENS.color.INK, bg) >= contrast(TOKENS.color.WHITE, bg)
    ? TOKENS.color.INK : TOKENS.color.WHITE;
}
// 自选色压某背景是否合规：正文需 ≥4.5；大号/粗体/标签 ≥3.0（WCAG AA）。large:true 走 3.0 档。
function assertReadable(fg, bg, { large = false, label = "" } = {}) {
  const r = contrast(fg, bg), need = large ? 3.0 : 4.5;
  if (r < need)
    throw new Error(
      `[对比度不足] ${label} fg=${fg} on bg=${bg} 比率=${r.toFixed(2)} < ${need}。` +
      `小字/正文别用浅色或强调色压浅底；用 QA.textOn('${bg}')='${textOn(bg)}'，或换更深/更浅的字色。`
    );
}

/* ---- 自动登记（替代手动 track）+ 越界 + 装饰压字 + 卡片重叠 ---- */
// monkey-patch addText/addShape/addImage：每个元素自动登记，漏不掉。
// 想参与重叠判定就在 opts 加 _role:'text'|'card'|'decoration'（会自动剥离后再交给 pptxgenjs）。
function instrument(slide) {
  const els = (slide.__els = []);
  const wrap = (name, optsIdx) => {
    if (typeof slide[name] !== "function") return;
    const orig = slide[name].bind(slide);
    slide[name] = (...args) => {
      const o = args[optsIdx] || {};
      const role = o._role || (name === "addText" ? "text" : name === "addImage" ? "image" : "shape");
      els.push({ role, x: o.x, y: o.y, w: o.w, h: o.h, text: args[0] });
      const clean = { ...o }; delete clean._role; delete clean._group;
      args[optsIdx] = clean;
      return orig(...args);
    };
  };
  wrap("addText", 1); wrap("addShape", 1); wrap("addImage", 0);
  return slide;
}
const _ovl = (a, b) =>
  a.x != null && b.x != null &&
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// 写文件前对每页跑：越界、装饰压文字、同级卡片互相重叠、正文字号失控。
function assertGeometry(slide, { W = 13.33, H = 7.5, margin = 0.4 } = {}) {
  const els = slide.__els || [];
  const errs = [];
  for (const e of els) {
    if (e.x == null || e.w == null) continue;
    if (e.x < margin - 1e-6 || e.y < margin - 1e-6 || e.x + e.w > W - margin + 1e-6 || e.y + e.h > H - margin + 1e-6)
      errs.push(`越界: ${e.role} "${String(e.text || "").slice(0, 14)}" @(${e.x},${e.y}) 尺寸(${e.w}x${e.h})`);
  }
  const deco = els.filter((e) => e.role === "decoration");
  const text = els.filter((e) => e.role === "text");
  for (const d of deco) for (const t of text)
    if (_ovl(d, t)) errs.push(`装饰压文字: 装饰@(${d.x},${d.y}) 盖住 "${String(t.text || "").slice(0, 14)}"`);
  const cards = els.filter((e) => e.role === "card");
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++)
    if (_ovl(cards[i], cards[j])) errs.push(`卡片重叠: #${i}(@${cards[i].x},${cards[i].y}) 与 #${j}(@${cards[j].x},${cards[j].y})`);
  if (errs.length) throw new Error("[几何自检失败]\n  " + errs.join("\n  "));
  return slide;
}

// 正文字号上限（标题用 _role:'title' 或显式跳过）。
function assertBodySize(fontSize, { label = "", isTitle = false } = {}) {
  if (!isTitle && fontSize > TOKENS.size.BODY_MAX)
    throw new Error(`[字号超限] ${label} fontSize=${fontSize} > 正文上限 ${TOKENS.size.BODY_MAX}pt（标题除外，正文应 14-16pt）`);
}

module.exports = {
  TOKENS, hasCJK, pickFont,
  contrast, textOn, assertReadable,
  instrument, assertGeometry, assertBodySize,
};
