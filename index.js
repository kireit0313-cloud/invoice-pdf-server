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

  // 会社情報ブロック（社名・住所・電話・インボイス番号）
  const customFieldsHtml = (company.customFields || [])
    .filter(f => f && f.label && f.value)
    .map(f => `<div>${f.label}：${f.value}</div>`)
    .join('');

  const companyBlockHtml = `
    <div class="company-side">
      ${company.name ? `<div class="company-name">${company.name}</div>` : ''}
      ${company.address ? `<div>${company.address}</div>` : ''}
      ${company.tel ? `<div>TEL：${company.tel}</div>` : ''}
      ${company.invoiceNumber ? `<div>登録番号：${company.invoiceNumber}</div>` : ''}
      ${customFieldsHtml}
      <div class="stamp-box">印</div>
    </div>`;

  // 案件情報・送付先情報ブロック（会社情報とは独立、クライアント名の下に表示）
  const projectFieldsHtml = (projectFields || [])
    .filter(f => f && f.label && f.value)
    .map(f => `
      <div class="project-field-row">
        <span class="project-field-label">${f.label}</span>
        <span class="project-field-value">${f.value}</span>
      </div>`)
    .join('');

  const projectInfoBlockHtml = projectFieldsHtml
    ? `<div class="project-info">${projectFieldsHtml}</div>`
    : '';

  // 自由記入欄（下段）：未記入なら非表示
  const remarksLowerBlockHtml = (remarksLower && remarksLower.trim())
    ? `<div class="remarks-lower">${remarksLower.trim().replace(/\n/g, '<br>')}</div>`
    : '';

  // 明細行のHTML生成
  const itemRows = items.map(item => `
    <tr>
      <td>${item.workDate || ''}</td>
      <td>${item.service || ''}</td>
      <td class="num">${item.qty === null || item.qty === undefined ? '' : item.qty}</td>
      <td class="num">${item.price === null || item.price === undefined ? '' : '¥' + Number(item.price).toLocaleString()}</td>
      <td class="num">¥${Number(item.amount || 0).toLocaleString()}</td>
      <td class="num">${item.taxRate || 0}%</td>
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

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
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
  }
  .meta {
    display: flex;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .client-block { display: flex; flex-direction: column; justify-content: flex-end; }
  .client-name {
    font-size: 20px;
    font-weight: bold;
    border-bottom: 2px solid #1A202C;
    padding-bottom: 4px;
    min-width: 220px;
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
  .stamp-box {
    width: 56px;
    height: 56px;
    border: 1px solid #718096;
    border-radius: 50%;
    margin-left: auto;
    margin-top: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #CBD5E0;
    font-size: 12px;
  }
  .total-highlight {
    border: 2px solid #1A202C;
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
  }
  .total-highlight-value {
    font-size: 22px;
    font-weight: bold;
    letter-spacing: 1px;
  }
  .project-info {
    background: #F8F9FA;
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 20px;
  }
  .project-field-row {
    display: flex;
    font-size: 13px;
    padding: 2px 0;
  }
  .project-field-label { min-width: 110px; color: #718096; }
  .project-field-value { color: #1A202C; }
  .remarks-lower {
    background: #F8F9FA;
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    padding: 12px 16px;
    margin-top: -4px;
    margin-bottom: 20px;
    font-size: 13px;
    color: #1A202C;
    line-height: 1.6;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }
  th {
    background: #F8F9FA;
    border: 1px solid #E2E8F0;
    padding: 8px 10px;
    text-align: left;
    font-weight: 500;
    color: #718096;
    font-size: 12px;
  }
  td {
    border: 1px solid #E2E8F0;
    padding: 8px 10px;
    font-size: 13px;
  }
  .num { text-align: right; }
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
    border: 1px solid #E2E8F0;
    border-radius: 6px;
    padding: 12px 16px;
    background: #F8F9FA;
  }
  .bank-info-title {
    font-size: 14px;
    font-weight: bold;
    margin-bottom: 6px;
    border-bottom: 1px solid #E2E8F0;
    padding-bottom: 4px;
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
        <th style="width:11%">${L[0]}</th>
        <th style="width:30%">${L[1]}</th>
        <th style="width:7%" class="num">${L[2]}</th>
        <th style="width:13%" class="num">${L[3]}</th>
        <th style="width:14%" class="num">${L[4]}</th>
        <th style="width:7%" class="num">税率</th>
        <th style="width:18%">${L[5]}</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  ${remarksLowerBlockHtml}

  <div class="totals">
    ${totalRowsHtml}
    <div class="total-row" style="font-size:15px;font-weight:bold;color:#1A202C;border-top:2px solid #1A202C;padding-top:8px;margin-top:4px;">
      <span class="total-label">合計</span>
      <span class="total-value">¥${grandTotal.toLocaleString()}</span>
    </div>
  </div>

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
      args: ['--no-sandbox', '--disable-setuid-sandbox']
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
