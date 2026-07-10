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
  const { clientName, items, docType, companyInfo, projectFields, remarksLower, issueDate: issueDateInput, honorific: honorificInput, columnLabels } = req.body;

  if (!clientName || !items) {
    return res.status(400).json({ error: 'clientName と items は必須です' });
  }

  const title = docType === '見積書' ? '見積書' : '請求書';
  const company = companyInfo || {};

  // 明細ラベル（クライアント別カスタマイズ、未指定時はデフォルト）
  const defaultLabels = ['作業日', 'サービス名', '数量', '単価（円）', '金額（円）', '備考'];
  const L = (columnLabels && columnLabels.length === 6) ? columnLabels : defaultLabels;

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
      // 自動生成角印：writing-mode縦書き（vertical-rl）で右→左・上→下に自動配置
      // 自動生成角印：文字数に応じて枠を自動拡大（1マス=18px、列数=√文字数、上限80px）。
      // フォントはマス目より小さく（列幅-3px、最大15px）して、どの文字数でも枠と文字が重ならないよう余白を確保。
      const n = [...String(company.name)].length;
      const grid = Math.ceil(Math.sqrt(n));
      let box = grid * 18 + 12; // 枠 = 列数×18 + padding4×2 + border2×2
      if (box > 80) box = 80;
      if (box < 44) box = 44;
      const inner = box - 12;
      const font = Math.max(6, Math.min(15, Math.floor(inner / grid) - 3));
      sealHtml = `<div class="seal-auto" style="width:${box}px;height:${box}px"><div class="seal-auto-text" style="font-size:${font}px">${company.name}</div></div>`;
    }
  }

  const companyBlockHtml = `
    <div class="company-side">
      ${company.name ? `<div class="company-name">${company.name}</div>` : ''}
      ${companyFieldsHtml}
      ${sealHtml}
    </div>`;

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
      <td>${item.workDate || ''}</td>
      <td>${item.service || ''}</td>
      <td class="num">${item.qty === null || item.qty === undefined ? '' : item.qty}</td>
      <td class="num">${item.price === null || item.price === undefined ? '' : '¥' + Number(item.price).toLocaleString()}</td>
      <td class="num">¥${Number(item.amount || 0).toLocaleString()}</td>
      <td class="num">${Number(item.taxRate) > 0 ? Number(item.taxRate) + '%' : ''}</td>
      <td>${item.remark || ''}</td>
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
  const themeVars = themeMode === 'color'
    ? `--c-underline:${brand};--c-hl-border:${brand};--c-hl-bg:${tintBg};--c-hl-text:${brand};--c-th-bg:${brand};--c-th-text:#ffffff;--c-th-border:${brand};--c-box-bg:${tintBg};--c-box-border:${tintBorder};--c-box-label:${brand};--c-section-title:${brand};--c-total-line:${brand};--c-free-bg:#ffffff;--c-free-border:${brand};--c-free-label:${brand};`
    : `--c-underline:#1A202C;--c-hl-border:#1A202C;--c-hl-bg:transparent;--c-hl-text:#1A202C;--c-th-bg:#F8F9FA;--c-th-text:#718096;--c-th-border:#E2E8F0;--c-box-bg:#F8F9FA;--c-box-border:#E2E8F0;--c-box-label:#718096;--c-section-title:#1A202C;--c-total-line:#1A202C;--c-free-bg:#F8F9FA;--c-free-border:#E2E8F0;--c-free-label:#718096;`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
  :root { ${themeVars} }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif;
    font-size: 13px;
    color: #1A202C;
    padding: 40px;
    width: 794px;
  }
  h1 {
    font-size: 22px;
    font-weight: bold;
    text-align: center;
    margin-bottom: 24px;
    letter-spacing: 4px;
    color: #1A202C;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .client-block { display: flex; flex-direction: column; justify-content: flex-start; padding-top: 30px; }
  .client-name {
    font-size: 20px;
    font-weight: bold;
    border-bottom: 2px solid var(--c-underline);
    padding-bottom: 4px;
    min-width: 220px;
    text-align: center;
  }
  .client-name span { font-size: 14px; font-weight: normal; margin-left: 4px; }
  .greeting {
    font-size: 13px;
    margin-top: 12px;
    color: #1A202C;
  }
  .company-side {
    text-align: right;
    font-size: 12px;
    color: #1A202C;
    line-height: 1.7;
  }
  .issue-date-line {
    font-size: 13px;
    color: #1A202C;
    margin-bottom: 6px;
    text-align: right;
  }
  .company-name { font-size: 14px; font-weight: bold; margin-bottom: 2px; }
  .seal-auto {
    border: 2px solid #C0392B;
    border-radius: 3px;
    margin-left: auto;
    margin-top: 8px;
    padding: 4px;
    display: flex;
    align-items: stretch;
    justify-content: center;
    overflow: hidden;
  }
  .seal-auto-text {
    writing-mode: vertical-rl;
    text-orientation: upright;
    text-align: start;
    color: #C0392B;
    font-weight: bold;
    font-family: serif;
    line-height: 1.0;
    letter-spacing: 0;
    height: 100%;
  }
  .seal-img {
    width: 58px;
    height: 58px;
    object-fit: contain;
    margin-left: auto;
    margin-top: 8px;
    display: block;
  }
  .total-highlight {
    border: 2px solid var(--c-hl-border);
    background: var(--c-hl-bg);
    border-radius: 4px;
    padding: 10px 20px;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .total-highlight-label {
    font-size: 14px;
    font-weight: bold;
    min-width: 100px;
    color: var(--c-hl-text);
  }
  .total-highlight-value {
    font-size: 22px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--c-hl-text);
  }
  .project-info {
    background: var(--c-free-bg);
    border: 1px solid var(--c-free-border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 20px;
  }
  .project-field-row {
    display: flex;
    font-size: 13px;
    padding: 2px 0;
  }
  .project-field-label { min-width: 110px; color: var(--c-free-label); }
  .project-field-value { color: #1A202C; }
  .remarks-lower {
    background: var(--c-free-bg);
    border: 1px solid var(--c-free-border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-top: 20px;
    margin-bottom: 0;
    font-size: 13px;
    color: #1A202C;
    line-height: 1.6;
  }
  table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    margin-bottom: 16px;
  }
  th {
    background: var(--c-th-bg);
    border: 1px solid var(--c-th-border);
    padding: 8px 5px;
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
    border: 1px solid #E2E8F0;
    padding: 8px 6px;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  td.num { text-align: right; }
  .totals {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    margin-bottom: 20px;
  }
  .total-row {
    display: flex;
    gap: 24px;
    font-size: 13px;
    color: #718096;
  }
  .total-label { min-width: 140px; text-align: right; }
  .total-value { min-width: 100px; text-align: right; }
  .bank-info {
    margin-top: 20px;
    border: 1px solid var(--c-box-border);
    border-radius: 0;
    padding: 12px 16px;
    background: var(--c-box-bg);
  }
  .bank-info-title {
    font-size: 14px;
    font-weight: bold;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--c-box-border);
    padding-bottom: 4px;
    color: var(--c-section-title);
  }
  .bank-info-body {
    font-size: 14px;
    line-height: 1.8;
    color: #1A202C;
  }
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
        <th style="width:15%">${L[0]}</th>
        <th style="width:31%">${L[1]}</th>
        <th style="width:6%" class="num">${L[2]}</th>
        <th style="width:14%" class="num">${L[3]}</th>
        <th style="width:14%" class="num">${L[4]}</th>
        <th style="width:6%" class="num">税率</th>
        <th style="width:14%">${L[5]}</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div class="totals">
    ${totalRowsHtml}
    <div class="total-row" style="font-size:15px;font-weight:bold;color:var(--c-total-line);border-top:2px solid var(--c-total-line);padding-top:8px;margin-top:4px;">
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
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' }
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
