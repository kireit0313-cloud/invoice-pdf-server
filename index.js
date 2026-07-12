const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS設定（Vercelからのリクエストを許可）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ヘルスチェック
app.get('/', (req, res) => {
  res.send('invoice-pdf-server is running');
});

// 今日の日付を yyyy/mm/dd 形式で返す
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// 税率の表示用フォーマット（不要な小数点を消す）
function formatRate(rate) {
  return Number(rate).toString();
}

// 明細データを税率ごとにグループ化して、小計・消費税・合計を計算する
function buildTaxGroups(items) {
  const groups = new Map(); // rate(number) -> subtotal
  items.forEach(item => {
    const amount = Number(item.amount) || 0;
    const rate = item.taxRate === null || item.taxRate === undefined || item.taxRate === ''
      ? 0
      : (parseInt(item.taxRate) || 0);
    groups.set(rate, (groups.get(rate) || 0) + amount);
  });

  // 税率の高い順に並べる（0%は最後）
  const sorted = [...groups.entries()].sort((a, b) => b[0] - a[0]);

  let grandTotal = 0;
  const rows = sorted.map(([rate, subtotal]) => {
    const taxAmount = rate > 0 ? Math.floor(subtotal * (rate / 100)) : 0;
    grandTotal += subtotal + taxAmount;
    return { rate, subtotal, taxAmount };
  });

  return { rows, grandTotal };
}

// PDF生成エンドポイント
app.post('/generate-pdf', async (req, res) => {
  const { clientName, items, docType, companyInfo, projectFields, remarksLower, issueDate: issueDateInput, honorific: honorificInput, columnLabels, colFlags, invoiceNo } = req.body;

  if (!clientName || !items) {
    return res.status(400).json({ error: 'clientName と items は必須です' });
  }

  const title = docType === '見積書' ? '見積書' : '請求書';
  const company = companyInfo || {};

  // 明細ラベル（クライアント別カスタマイズ、未指定時はデフォルト）
  const defaultLabels = ['日付', '内容', '数量', '単価（税抜）', '金額（税抜）', '備考'];
  const L = (columnLabels && columnLabels.length === 6) ? columnLabels : defaultLabels;

  // 明細列の表示ON/OFF（管理画面設定）。オプション列＝数量・単価・備考。
  // 未指定（旧クライアント）は全て表示。作業日・サービス名・金額・税率は常時表示。
  const flags = colFlags || {};
  const showCol = { qty: flags.qty !== false, price: flags.price !== false, remark: flags.remark !== false };
  // 列定義（順序固定・実測済みの基準幅）。オプション列を除外し、残り幅を100%へ按分。
  const colDefs = [
    { key: 'date',    label: L[0],   w: 15, num: false },
    { key: 'service', label: L[1],   w: 31, num: false },
    { key: 'qty',     label: L[2],   w: 6,  num: true,  opt: true },
    { key: 'price',   label: L[3],   w: 14, num: true,  opt: true },
    { key: 'amount',  label: L[4],   w: 14, num: true },
    { key: 'tax',     label: '税率', w: 6,  num: true },
    { key: 'remark',  label: L[5],   w: 14, num: false, opt: true },
  ].filter(c => !c.opt || showCol[c.key]);
  const wSum = colDefs.reduce((a, c) => a + c.w, 0);
  const colPct = (c) => (c.w / wSum * 100).toFixed(2);
  const cellHtml = (item, key) => {
    switch (key) {
      case 'date':    return `<td>${item.workDate || ''}</td>`;
      case 'service': return `<td>${item.service || ''}</td>`;
      case 'qty':     return `<td class="num">${item.qty === null || item.qty === undefined ? '' : item.qty}</td>`;
      case 'price':   return `<td class="num">${item.price === null || item.price === undefined ? '' : '¥' + Number(item.price).toLocaleString()}</td>`;
      case 'amount':  return `<td class="num">¥${Number(item.amount || 0).toLocaleString()}</td>`;
      case 'tax':     return `<td class="num">${Number(item.taxRate) > 0 ? Number(item.taxRate) + '%' : ''}</td>`;
      case 'remark':  return `<td>${item.remark || ''}</td>`;
      default:        return '';
    }
  };

  // 会社情報ブロック（社名＋並び順どおりの項目リスト）
  // 新形式：company.fields = [{label, value}, ...]（UIの並び順＝表示順）
  // 旧形式（fields未設定）：住所→TEL→登録番号→追加項目 の順に自動変換し、従来の見た目を維持
  const companyFields = Array.isArray(company.fields)
    ? company.fields
    : [
        { label: '', value: company.address || '' },
        { label: 'TEL', value: company.tel || '' },
        { label: '登録番号', value: company.invoiceNumber || '' },
        ...(company.customFields || []),
      ];
  const companyFieldsHtml = companyFields
    .filter(f => f && f.value != null && String(f.value).trim() !== '')
    .map(f => {
      const label = (f.label || '').trim();
      const value = String(f.value).replace(/\n/g, '<br>');
      return `<div>${label ? label + '：' : ''}${value}</div>`;
    })
    .join('');

  // 印鑑（角印）: クライアント単位設定。company.seal = { enabled, mode:'auto'|'image', imageData }
  // 未設定（seal無し）の場合は非表示（従来の空円プレースホルダーは廃止）
  const seal = company.seal || {};
  let sealHtml = '';
  if (seal.enabled) {
    if (seal.mode === 'image' && seal.imageData) {
      sealHtml = `<img class="seal-img" src="${seal.imageData}" alt="印">`;
    } else if (company.name) {
      // 自動生成角印：文字をマス目いっぱいに均等配置（flexで詰めて余白を最小化）。
      // 列は右→左、各列は上→下（縦書きの読み順）。余りは右側の列から1文字ずつ割り当て。
      // 枠＝max(列,行)×20＋12(border3×2＋padding3×2)。フォントはセルの短辺×0.94で算出。
      const chars = [...String(company.name)];
      const n = chars.length;
      const cols = Math.ceil(Math.sqrt(n));
      const maxRows = Math.ceil(n / cols);
      const box = 68;           // 角印サイズは固定（文字数によらず一定）
      const inner = box - 12;
      const cellH = inner / maxRows; // 1文字セルの高さ（固定）＝上そろえの基準
      const fs = (Math.min(inner / cols, cellH) * 0.94).toFixed(1);
      // 右の列から1列＝maxRows文字ずつ完全に埋め、余りを最後（左）の列へ（例：7文字→あいう／えおか／き）
      // 長音符・ダッシュ（ー等）は縦書き風に90°回転して縦棒にする（例：ローソンの「ー」）
      const vertRe = /[ー−—―－‐−]/;
      let idx = 0, colsHtml = '';
      for (let c = 0; c < cols; c++) {
        const cnt = Math.min(maxRows, n - idx);
        if (cnt <= 0) break;
        let spans = '';
        for (let k = 0; k < cnt; k++) {
          const ch = chars[idx++];
          const rot = vertRe.test(ch) ? ' seal-ch-vert' : '';
          spans += `<span class="seal-ch${rot}" style="height:${cellH.toFixed(1)}px">${ch}</span>`;
        }
        colsHtml += `<div class="seal-col">${spans}</div>`;
      }
      sealHtml = `<div class="seal-auto" style="width:${box}px;height:${box}px"><div class="seal-inner" style="font-size:${fs}px">${colsHtml}</div></div>`;
    }
  }

  const companyBlockHtml = `
    ${company.name ? `<div class="company-name">${company.name}</div>` : ''}
    ${companyFieldsHtml}
    ${sealHtml}`;

  // 案件情報・送付先情報ブロック（会社情報とは独立、クライアント名の下に表示）
  // 項目名（label）が空欄でも、内容（value）があればフリー記入として表示する
  const projectFieldsHtml = (projectFields || [])
    .filter(f => f && (f.label || f.value))
    .map(f => {
      const label = (f.label || '').trim();
      const value = f.value || '';
      return `
      <div class="project-field-row">
        ${label ? `<span class="project-field-label">${label}</span>` : ''}
        <span class="project-field-value">${value}</span>
      </div>`;
    })
    .join('');

  const projectInfoBlockHtml = projectFieldsHtml
    ? `<div class="project-info">${projectFieldsHtml}</div>`
    : '';

  // 自由記入欄（下段）：未記入なら非表示。PDFでは最下部（振込先の下）に表示する
  const remarksLowerBlockHtml = (remarksLower && remarksLower.trim())
    ? `<div class="remarks-lower">${remarksLower.trim().replace(/\n/g, '<br>')}</div>`
    : '';

  // 明細行のHTML生成（税率が0または未設定のときは空欄にする）
  const itemRows = items.map(item => `
    <tr>
      ${colDefs.map(c => cellHtml(item, c.key)).join('')}
    </tr>
  `).join('');

  // 税率ごとの内訳・合計を計算
  const { rows: taxRows, grandTotal } = buildTaxGroups(items);

  const totalRowsHtml = taxRows.map(({ rate, subtotal, taxAmount }) => {
    if (rate > 0) {
      return `
        <div class="total-row">
          <span class="total-label">${formatRate(rate)}%対象小計</span>
          <span class="total-value">¥${subtotal.toLocaleString()}</span>
        </div>
        <div class="total-row">
          <span class="total-label">消費税（${formatRate(rate)}%）</span>
          <span class="total-value">¥${taxAmount.toLocaleString()}</span>
        </div>`;
    }
    return `
      <div class="total-row">
        <span class="total-label">対象外・税込小計</span>
        <span class="total-value">¥${subtotal.toLocaleString()}</span>
      </div>`;
  }).join('');

  const issueDate = issueDateInput || todayStr();

  const honorific = (honorificInput === '様') ? '様' : '御中';

  // カラーテーマ: company.theme = { mode:'gray'|'color', color:'#hex' }
  // グレー時は従来の配色をそのまま維持。カラー時のみ会社カラーを一部要素に適用する。
  const theme = company.theme || {};
  const themeMode = (theme.mode === 'color' && theme.color) ? 'color' : 'gray';
  const hexToRgb = (h) => {
    let s = String(h).replace('#', '').trim();
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    const n = parseInt(s, 16);
    if (!Number.isFinite(n)) return { r: 24, g: 95, b: 165 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const toHex = (c) => {
    const t = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + t(c.r) + t(c.g) + t(c.b);
  };
  const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  const lum = (c) => {
    const f = [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  // 会社カラーが明るすぎると白文字や白地の文字が読みにくいため、十分暗くなるまで黒を混ぜる
  let brandRgb = hexToRgb(theme.color || '#185FA5');
  for (let i = 0; i < 12 && lum(brandRgb) > 0.32; i++) brandRgb = mix(brandRgb, { r: 0, g: 0, b: 0 }, 0.12);
  const white = { r: 255, g: 255, b: 255 };
  const brand = toHex(brandRgb);
  const tintBg = toHex(mix(brandRgb, white, 0.90));     // うすい背景色
  const tintBorder = toHex(mix(brandRgb, white, 0.65)); // うすい枠線色
  // 案B（左アクセントライン）用のCSS変数。
  // --c-brand: 主アクセント（縦バー・合計帯・見出し・明細ヘッダー下線・合計上線）
  // --c-band-bg: 税込合計帯の背景（薄い地色）  --c-subbar: 補助セクションの左バー（薄色）
  const themeVars = themeMode === 'color'
    ? `--c-brand:${brand};--c-band-bg:${tintBg};--c-subbar:${tintBorder};--c-th-text:#718096;--c-label:#718096;`
    : `--c-brand:#2C3E50;--c-band-bg:#F4F6F8;--c-subbar:#CBD5E0;--c-th-text:#718096;--c-label:#718096;`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap" rel="stylesheet">
<style>
  :root { ${themeVars} }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif;
    font-size: 13px;
    color: #1A202C;
    padding: 0;
    width: 100%;
  }
  h1 {
    font-size: 23px;
    font-weight: bold;
    text-align: center;
    margin-bottom: 26px;
    letter-spacing: 6px;
    color: #1A202C;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }
  .client-block { display: flex; flex-direction: column; padding-top: 30px; }
  /* 取引先名：下線ではなく左アクセントバー（案B） */
  .client-name {
    font-size: 19px;
    font-weight: bold;
    border-left: 4px solid var(--c-brand);
    padding: 4px 0 4px 14px;
    min-width: 220px;
    text-align: left;
  }
  .client-name span { font-size: 13px; font-weight: normal; margin-left: 6px; }
  .greeting {
    font-size: 12px;
    margin-top: 12px;
    padding-left: 14px;
    color: #718096;
  }
  .company-side {
    text-align: right;
    font-size: 12px;
    color: #1A202C;
    line-height: 1.75;
  }
  .invoice-no-line {
    font-size: 12px;
    color: #718096;
    margin-bottom: 2px;
    text-align: right;
  }
  .issue-date-line {
    font-size: 12px;
    color: #718096;
    margin-bottom: 6px;
    text-align: right;
  }
  .company-name { font-size: 14px; font-weight: bold; margin-bottom: 2px; }
  .seal-auto {
    border: 3px solid #C0392B;
    border-radius: 3px;
    margin-left: auto;
    margin-top: 8px;
    padding: 3px;
    box-sizing: border-box;
    background: #fff;
    overflow: hidden;
  }
  .seal-inner { display: flex; flex-direction: row-reverse; width: 100%; height: 100%; }
  .seal-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-start; }
  .seal-ch {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    color: #C0392B;
    font-weight: 700;
    font-family: 'Yuji Syuku', serif;
  }
  .seal-ch-vert { transform: rotate(90deg); }
  .seal-img {
    width: 58px;
    height: 58px;
    object-fit: contain;
    margin-left: auto;
    margin-top: 8px;
    display: block;
  }
  /* 税込合計：囲みをやめ、左バー＋薄い地色の帯（案B） */
  .total-highlight {
    border-left: 4px solid var(--c-brand);
    background: var(--c-band-bg);
    padding: 12px 18px;
    margin-bottom: 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .total-highlight-label {
    font-size: 13px;
    font-weight: bold;
    color: var(--c-brand);
  }
  .total-highlight-value {
    font-size: 24px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--c-brand);
  }
  /* 自由記入欄（上段）：囲みをやめ、薄い左バーのみ（案B） */
  .project-info {
    border-left: 4px solid var(--c-subbar);
    padding-left: 14px;
    margin-bottom: 22px;
  }
  .project-field-row {
    display: flex;
    font-size: 13px;
    padding: 2px 0;
  }
  .project-field-label { min-width: 110px; color: var(--c-label); }
  .project-field-value { color: #1A202C; }
  /* 自由記入欄（下段）：囲みをやめ、薄い左バーのみ（案B） */
  .remarks-lower {
    border-left: 4px solid var(--c-subbar);
    padding-left: 14px;
    margin-top: 22px;
    margin-bottom: 0;
    font-size: 12.5px;
    color: #1A202C;
    line-height: 1.7;
  }
  table {
    width: 100%;
    table-layout: fixed;
    border-collapse: separate;
    border-spacing: 0;
    margin-bottom: 16px;
  }
  /* 明細：外枠・縦罫線をやめ、ヘッダー下線＋行下線のみ（案B） */
  th {
    border-bottom: 2px solid var(--c-brand);
    padding: 7px 5px;
    text-align: center;
    font-weight: 500;
    color: var(--c-th-text);
    font-size: 11px;
    line-height: 1.25;
    letter-spacing: -0.2px;
    word-break: keep-all;
    overflow-wrap: anywhere;
  }
  td {
    border-bottom: 1px solid #E2E8F0;
    padding: 9px 6px;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  td.num { text-align: right; }
  .totals {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 5px;
    margin-bottom: 0;
  }
  .total-row {
    display: flex;
    gap: 24px;
    font-size: 12.5px;
    color: #718096;
  }
  .total-label { min-width: 140px; text-align: right; }
  .total-value { min-width: 100px; text-align: right; }
  /* 振込先：囲みをやめ、薄い左バー＋小見出し（案B） */
  .bank-info {
    margin-top: 22px;
    border-left: 4px solid var(--c-subbar);
    padding-left: 14px;
  }
  .bank-info-title {
    font-size: 13.2px;
    font-weight: bold;
    letter-spacing: 1px;
    margin-bottom: 5px;
    color: var(--c-brand);
  }
  .bank-info-body {
    font-size: 16.2px;
    line-height: 1.8;
    color: #1A202C;
  }
  /* --- 複数ページ対応（明細がA4を超えたとき） --- */
  thead { display: table-header-group; }   /* 見出し行を各ページの先頭に自動反復 */
  tr { page-break-inside: avoid; }         /* 行を改ページ境界で上下に割らない */
  .total-highlight, .totals, .remarks-lower, .bank-info { page-break-inside: avoid; } /* まとまりを分断しない */
</style>
</head>
<body>
  <h1>${title.split('').join('　')}</h1>

  <div class="meta">
    <div class="client-block">
      <div class="client-name">${clientName}<span>${honorific}</span></div>
      <div class="greeting">下記の通りご請求申し上げます。</div>
    </div>
    <div class="company-side">
      ${(invoiceNo && String(invoiceNo).trim()) ? `<div class="invoice-no-line">請求書番号：${String(invoiceNo).trim()}</div>` : ''}
      <div class="issue-date-line">請求日：${issueDate}</div>
      ${companyBlockHtml}
    </div>
  </div>

  <div class="total-highlight">
    <span class="total-highlight-label">税込合計金額</span>
    <span class="total-highlight-value">¥${grandTotal.toLocaleString()}</span>
  </div>

  ${projectInfoBlockHtml}

  <table>
    <thead>
      <tr>
        ${colDefs.map(c => `<th style="width:${colPct(c)}%"${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div class="totals">
    ${totalRowsHtml}
    <div class="total-row" style="font-size:15px;font-weight:bold;color:#1A202C;border-top:2px solid var(--c-brand);padding-top:8px;margin-top:4px;">
      <span class="total-label">合計</span>
      <span class="total-value">¥${grandTotal.toLocaleString()}</span>
    </div>
  </div>

  ${remarksLowerBlockHtml}

  ${(title === '請求書' && company.bankInfo) ? `
  <div class="bank-info">
    <div class="bank-info-title">お振込先</div>
    <div class="bank-info-body">${company.bankInfo.replace(/\n/g, '<br>')}</div>
  </div>` : ''}
</body>
</html>`;

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Webフォント（角印のYuji Syuku等）の読み込み完了を待ってからPDF化
    try { await page.evaluate(() => document.fonts.ready); } catch (_) {}
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '40px', right: '40px' }
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(clientName)}_${encodeURIComponent(issueDate.replace(/\//g, '-'))}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'PDF生成に失敗しました: ' + e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
