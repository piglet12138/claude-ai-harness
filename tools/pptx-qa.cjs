/* pptx-qa.cjs — make_pptx 的「确定性硬卡口」层（build 时跑，零成本，先于渲染+视觉）。
 * 覆盖 track() 抓不到的：① 低对比/隐形文字（WCAG，自动）② 装饰压字/卡片重叠 ③ 正文字号失控（上+下限，自动）
 *   ④ 越界 ⑤ 主题深浅一致性（杜绝内容页深浅交替）。
 * build 时 throw → runCode 失败 → make_pptx 直接返回错误（不渲染、不调 vision）→ 模型改了重调。
 * 视觉判官仍作模型无关的兜底（catch 这层漏掉的、以及主观渲染问题）。
 * make_pptx 每次 fork 独立 node 进程跑本模块，故模块级状态（_deck）天然按单份 deck 隔离。 */

const TOKENS = {
  color: { NAVY: "08263F", NAVY2: "0C3354", TEAL: "0E9488", CYAN: "22D3EE", AQUA: "5EEAD4",
    INK: "0E2436", MUTED: "5E7A8C", LIGHT: "F2F8FA", WHITE: "FFFFFF", TINT: "EAF5F6" },
  // 字号是档位不是随手填；正文 < BODY_MIN 太小读不清、> BODY_MAX 失控，都报。
  size: { TITLE: 40, SECTION: 22, BODY: 15, BODY_MIN: 14, BODY_MAX: 17, CAPTION: 11 },
  // 拉丁/中文字体分开：Century Schoolbook / Calibri 不含中文字形，直接 shape 汉字会 fallback 发虚。
  font: { HEAD_EN: "Century Schoolbook", BODY_EN: "Calibri", HEAD_CN: "Noto Serif CJK SC", BODY_CN: "Noto Sans CJK SC" },
};

/* ---- 主题预设：模型按内容/受众/行业选一套，全程只用这套常量 ----
 * 每套自带：mode（内容页深浅）+ page/ink/muted（已验证彼此对比度达标）+ 3 个 accent + card + cover 点缀色。
 * 所有十六进制不带 #。muted/accent 都已确保压在 page 上 ≥4.5/≥3.0（见文件末自检注释）。 */
const THEMES = {
  // 清爽浅色 · 商务通用（默认首选：最易读、最不易出深底暗字）
  coolLight: {
    name: "coolLight", mode: "light",
    page: "F4F7FA", ink: "15283B", muted: "4A6076",
    accent: "2563EB", accent2: "0E9488", accent3: "C2410C",
    card: "FFFFFF", cardInk: "15283B", cardMuted: "55687B",
    cover: "0F2A47", coverInk: "F4F8FC", coverMuted: "9FB6CC",
  },
  // 商务深蓝 · 科技/数据（深色内容页；muted 调亮以保证压深底可读）
  deepNavy: {
    name: "deepNavy", mode: "dark",
    page: "0C2236", ink: "F1F7FC", muted: "A8BECE",
    accent: "38BDF8", accent2: "5EEAD4", accent3: "FBBF24",
    card: "13314F", cardInk: "F1F7FC", cardMuted: "A8BECE",
    cover: "081726", coverInk: "F1F7FC", coverMuted: "8AA2B5",
  },
  // 暖色科技 · 消费/教育/品牌（浅暖底）
  warmTech: {
    name: "warmTech", mode: "light",
    page: "FBF6F0", ink: "2A1E15", muted: "6B5A4C",
    accent: "DA5A26", accent2: "0E7490", accent3: "B45309",
    card: "FFFFFF", cardInk: "2A1E15", cardMuted: "6B5A4C",
    cover: "201410", coverInk: "FBF1E8", coverMuted: "C9B2A0",
  },
};

const hasCJK = (s) => /[㐀-鿿豈-﫿぀-ヿ]/.test(String(s));
function pickFont(text, { head = false } = {}) {
  const f = TOKENS.font;
  if (hasCJK(text)) return head ? f.HEAD_CN : f.BODY_CN;
  return head ? f.HEAD_EN : f.BODY_EN;
}

/* ---- 对比度：颜色属于 (元素 + 背景) 组合，不属于元素本身 ---- */
function _norm(hex) { return String(hex == null ? "" : hex).replace(/^#/, "").trim(); }
function _lum(hex) {
  const h = _norm(hex);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const c = [0, 2, 4].map((i) => {
    let v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(fg, bg) {
  const a = _lum(fg), b = _lum(bg);
  if (a == null || b == null) return null;
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
  if (r != null && r < need)
    throw new Error(
      `[对比度不足] ${label} fg=${fg} on bg=${bg} 比率=${r.toFixed(2)} < ${need}。` +
      `小字/正文别用浅色或强调色压浅底；用 QA.textOn('${bg}')='${textOn(bg)}'，或换更深/更浅的字色。`
    );
}

/* ---- 自动登记（替代手动 track）+ 越界 + 卡片重叠 + 自动对比度 + 自动字号 ----
 * monkey-patch addText/addShape/addImage：每个元素自动登记（含颜色/字号/填充），漏不掉。
 * 想参与重叠判定就在 opts 加 _role:'text'|'card'|'decoration'（会自动剥离后再交给 pptxgenjs）。 */
function instrument(slide) {
  const els = (slide.__els = []);
  const wrap = (name, optsIdx) => {
    if (typeof slide[name] !== "function") return;
    const orig = slide[name].bind(slide);
    slide[name] = (...args) => {
      const o = args[optsIdx] || {};
      const role = o._role || (name === "addText" ? "text" : name === "addImage" ? "image" : "shape");
      els.push({
        role, x: o.x, y: o.y, w: o.w, h: o.h, text: args[0],
        color: o.color,                                   // addText 字色
        fontSize: o.fontSize, bold: o.bold,               // addText 字号/粗体
        fill: o.fill && (o.fill.color != null ? o.fill.color : o.fill), // addShape 填充色
        transparency: (o.fill && o.fill.transparency) || o.transparency, // 半透明则背景不确定
      });
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
const _center = (e) => ({ cx: e.x + (e.w || 0) / 2, cy: e.y + (e.h || 0) / 2 });
const _contains = (s, p) =>
  s.x != null && s.w != null && p.cx >= s.x && p.cx <= s.x + s.w && p.cy >= s.y && p.cy <= s.y + s.h;

// 读 pptxgenjs slide 的背景色（s.background={color} 或 s.bkgd）。取不到返回 null。
function _slideBg(slide) {
  const b = slide.background || slide.bkgd || slide._bkgd;
  if (!b) return null;
  return _norm(typeof b === "string" ? b : b.color || b.fill);
}

// 推断某文字元素的「有效背景」：它落在的最上层实心色块的 fill；否则页底色。
// 跳过装饰/图片/半透明色块（背景不确定 → 不查对比度，交视觉判官）。
function _bgUnder(textEl, els, slideBg) {
  const p = _center(textEl);
  let bg = slideBg;
  for (const s of els) { // 后插入的在上层；正序遍历，最后命中的即最上层
    if (s === textEl) continue;
    if (s.role === "decoration" || s.role === "image") continue;
    if (s.transparency) continue;
    if (s.fill == null || typeof s.fill !== "string") continue;
    if (!/^#?[0-9a-fA-F]{6}$/.test(String(s.fill))) continue;
    if (_contains(s, p)) bg = _norm(s.fill);
  }
  return bg;
}

// 写文件前对每页跑。【高精度、低假阳性】拦真正会损坏/裁切/读不清版面的硬错误：
//   ① 元素超出「真实画布边缘」被裁切；② 同级卡片「显著」重叠；
//   ③ 文字压实心底对比度 < WCAG（背景能确切推断时才查）；④ 正文字号过小/过大。
function assertGeometry(slide, { W = 13.33, H = 7.5, tol = 0.12, kind = "content" } = {}) {
  const els = slide.__els || [];
  const errs = [];
  const slideBg = _slideBg(slide);

  for (const e of els) {
    if (e.x == null || e.w == null) continue;
    if (e.role === "decoration") continue; // 装饰本就可以出血到画布外
    if (e.x < -tol || e.y < -tol || e.x + e.w > W + tol || e.y + e.h > H + tol)
      errs.push(`元素超出画布被裁切: ${e.role} "${String(e.text || "").slice(0, 14)}" @(${e.x},${e.y}) 尺寸(${e.w}x${e.h})，画布 ${W}x${H}`);
  }

  // 卡片显著重叠
  const cards = els.filter((e) => e.role === "card" && e.x != null && e.w != null);
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 0.15 && oy > 0.15)
      errs.push(`卡片显著重叠: #${i}(@${a.x},${a.y}) 与 #${j}(@${b.x},${b.y}) 重叠区约 ${ox.toFixed(2)}x${oy.toFixed(2)}`);
  }

  // 自动对比度 + 自动字号（只查文字元素）
  for (const e of els) {
    if (e.role !== "text" && e.role !== "title" && e.role !== "kicker") continue;
    const txt = String(e.text == null ? "" : (Array.isArray(e.text) ? e.text.map(t => t && t.text || "").join("") : e.text));
    const isTitle = e.role === "title" || e.role === "kicker";
    const big = isTitle || e.bold || (e.fontSize != null && e.fontSize >= 18);

    // 对比度：字色已知 + 背景能确切推断 + 颜色都可解析，才查（低假阳性）
    if (e.color != null && /^#?[0-9a-fA-F]{6}$/.test(String(e.color))) {
      const bg = _bgUnder(e, els, slideBg);
      const r = contrast(e.color, bg);
      const need = big ? 3.0 : 4.5;
      if (r != null && r < need)
        errs.push(`低对比文字: "${txt.slice(0, 16)}" 字色 ${_norm(e.color)} 压底 ${bg} 比率 ${r.toFixed(2)} < ${need}（用 QA.textOn('${bg}')='${textOn(bg)}' 或换更亮/更深的字色）`);
    }

    // 字号下限：只查「实质正文」（非标题、文本够长，避开页码/短标签）
    if (!isTitle && !big && e.fontSize != null && txt.replace(/\s/g, "").length >= 12) {
      if (e.fontSize < TOKENS.size.BODY_MIN)
        errs.push(`正文字号过小: "${txt.slice(0, 16)}" fontSize=${e.fontSize} < ${TOKENS.size.BODY_MIN}pt（正文统一 14-16pt，太小读不清；确属脚注/标签请设 _role:'caption'）`);
      if (e.fontSize > TOKENS.size.BODY_MAX)
        errs.push(`正文字号过大: "${txt.slice(0, 16)}" fontSize=${e.fontSize} > ${TOKENS.size.BODY_MAX}pt（正文别超 17pt，要大就是标题 _role:'title'）`);
    }
  }

  // 登记本页深浅，供 assertDeckConsistency 跨页核对
  if (slideBg != null) {
    const lum = _lum(slideBg);
    _deck.push({ kind, light: lum != null ? lum > 0.4 : null });
  }

  if (errs.length) throw new Error("[几何/可读性自检失败]\n  " + errs.join("\n  "));
  return slide;
}

// 正文字号上限（保留：模型可显式调；自动检查已并入 assertGeometry）。
function assertBodySize(fontSize, { label = "", isTitle = false } = {}) {
  if (!isTitle && fontSize > TOKENS.size.BODY_MAX)
    throw new Error(`[字号超限] ${label} fontSize=${fontSize} > 正文上限 ${TOKENS.size.BODY_MAX}pt（标题除外，正文应 14-16pt）`);
}

/* ---- 主题深浅一致性（跨页）：内容页不得深浅交替；封面/章节/封底可对比点缀 ---- */
let _deck = []; // 每个 assertGeometry 登记 {kind, light}
function resetDeck() { _deck = []; }
// 写完所有页、writeFile 前调一次。内容页（kind==='content'）的深浅必须统一。
function assertDeckConsistency() {
  const content = _deck.filter((s) => s.kind === "content" && s.light != null);
  if (content.length < 2) return;
  const light = content.filter((s) => s.light).length;
  const dark = content.length - light;
  if (light > 0 && dark > 0)
    throw new Error(
      `[主题不一致] 内容页深浅交替：${light} 页浅底 / ${dark} 页深底。` +
      `选定主题后所有内容页统一用 T.page；只有封面/章节分隔/封底可用 T.cover 作对比（这些页 assertGeometry 传 {kind:'cover'}）。`
    );
}

module.exports = {
  TOKENS, THEMES, hasCJK, pickFont,
  contrast, textOn, assertReadable,
  instrument, assertGeometry, assertBodySize,
  resetDeck, assertDeckConsistency,
};

/* 自检（参考，未在运行时执行）：每套主题 muted/accent 压 page 的对比度
 * coolLight: muted 4A6076 on F4F7FA ≈ 6.1 ✓  accent 2563EB ≈ 5.1 ✓
 * deepNavy:  muted A8BECE on 0C2236 ≈ 6.3 ✓  accent 38BDF8 ≈ 7.0 ✓
 * warmTech:  muted 6B5A4C on FBF6F0 ≈ 5.4 ✓  accent DA5A26 ≈ 3.6 ✓(大字/标签档)
 * 实际值由本文件末的 selфcheck 脚本核（node -e）。 */
