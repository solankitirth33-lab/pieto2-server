/**
 * filegen.js — zero-dependency file generation for Pieto.
 * Turns Markdown-ish text into: pdf, docx, xlsx, html, md, txt, csv, json, or a raw code file.
 * Uses only Node built-ins (zlib, Buffer), so no npm install is needed.
 */
const zlib = require('zlib');

/* ----------------------------- ZIP (for docx/xlsx) ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0, dosDate = (46 << 9) | (1 << 5) | 1; // fixed date: 2026-01-01

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ----------------------------- Markdown parsing ----------------------------- */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Block-level parse -> [{type, ...}]
function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: fence[1] || '', text: code.join('\n') });
      continue;
    }

    if (/^\s*$/.test(line)) { flush(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); blocks.push({ type: 'h', level: Math.min(h[1].length, 3), text: h[2].trim() }); i++; continue; }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); blocks.push({ type: 'hr' }); i++; continue; }

    // Table: header row + separator row
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const splitRow = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const ul = line.match(/^(\s*)[-*+•]\s+(.*)$/);
    if (ul) { flush(); blocks.push({ type: 'li', ordered: false, indent: Math.floor(ul[1].length / 2), text: ul[2] }); i++; continue; }

    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) { flush(); blocks.push({ type: 'li', ordered: true, num: ol[2], indent: Math.floor(ol[1].length / 2), text: ol[3] }); i++; continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { flush(); blocks.push({ type: 'quote', text: q[1] }); i++; continue; }

    para.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

// Inline spans: **bold**, *italic*, `code`, [text](url)
function parseInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) out.push({ t: tok.slice(2, -2), b: true });
    else if (tok.startsWith('`')) out.push({ t: tok.slice(1, -1), c: true });
    else if (tok.startsWith('[')) { const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/); out.push({ t: mm[1], link: mm[2] }); }
    else out.push({ t: tok.slice(1, -1), i: true });
    last = m.index + tok.length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

const plainInline = t => parseInline(t).map(s => s.t).join('');

/* ----------------------------- HTML ----------------------------- */

function inlineHtml(text) {
  return parseInline(text).map(s => {
    const t = esc(s.t);
    if (s.c) return `<code>${t}</code>`;
    if (s.link) return `<a href="${esc(s.link)}">${t}</a>`;
    if (s.b) return `<strong>${t}</strong>`;
    if (s.i) return `<em>${t}</em>`;
    return t;
  }).join('');
}

function toHtml(title, md) {
  const blocks = parseMarkdown(md);
  let body = '';
  let listType = null;
  const closeList = () => { if (listType) { body += `</${listType}>`; listType = null; } };

  for (const b of blocks) {
    if (b.type !== 'li') closeList();
    switch (b.type) {
      case 'h': body += `<h${b.level}>${inlineHtml(b.text)}</h${b.level}>`; break;
      case 'p': body += `<p>${inlineHtml(b.text)}</p>`; break;
      case 'hr': body += '<hr>'; break;
      case 'quote': body += `<blockquote>${inlineHtml(b.text)}</blockquote>`; break;
      case 'code': body += `<pre><code>${esc(b.text)}</code></pre>`; break;
      case 'table':
        body += '<div class="tw"><table><thead><tr>' + b.header.map(c => `<th>${inlineHtml(c)}</th>`).join('') + '</tr></thead><tbody>' +
          b.rows.map(r => '<tr>' + r.map(c => `<td>${inlineHtml(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
        break;
      case 'li': {
        const want = b.ordered ? 'ol' : 'ul';
        if (listType !== want) { closeList(); body += `<${want}>`; listType = want; }
        body += `<li>${inlineHtml(b.text)}</li>`;
        break;
      }
    }
  }
  closeList();

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0f1115;--fg:#e8e6e1;--mut:#9a9890;--acc:#c9a84c;--card:#171a21;--line:#262a33}
@media (prefers-color-scheme:light){:root{--bg:#faf8f4;--fg:#1d1c1a;--mut:#6b6860;--acc:#9a7a1e;--card:#fff;--line:#e6e1d6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 20px 96px}
h1,h2,h3{line-height:1.25;letter-spacing:-.01em}h1{font-size:2rem;margin:0 0 .6em;border-bottom:2px solid var(--acc);padding-bottom:.3em}
h2{margin-top:1.8em}a{color:var(--acc)}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--acc);color:var(--mut)}
pre{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:auto}
code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}p code,li code{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.tw{overflow:auto}table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid var(--line);padding:8px 12px;text-align:left}th{background:var(--card)}
</style></head><body><main>${/^<h1/.test(body) ? '' : `<h1>${esc(title)}</h1>`}${body}</main></body></html>`;
}

/* ----------------------------- DOCX ----------------------------- */

function runXml(span, base = {}) {
  const b = span.b || base.b, i = span.i || base.i, c = span.c || base.c;
  let rpr = '';
  if (b) rpr += '<w:b/>';
  if (i) rpr += '<w:i/>';
  if (c) rpr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F0EDE6"/>';
  if (span.link) rpr += '<w:color w:val="9A7A1E"/><w:u w:val="single"/>';
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(span.t)}</w:t></w:r>`;
}

const paraXml = (text, pPr = '', base = {}) =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${parseInline(text).map(s => runXml(s, base)).join('')}</w:p>`;

function toDocx(title, md) {
  const blocks = parseMarkdown(md);
  let body = '';
  const firstIsH1 = blocks[0] && blocks[0].type === 'h' && blocks[0].level === 1;
  if (!firstIsH1 && title) body += paraXml(title, '<w:pStyle w:val="Heading1"/>');

  for (const b of blocks) {
    switch (b.type) {
      case 'h': body += paraXml(b.text, `<w:pStyle w:val="Heading${b.level}"/>`); break;
      case 'p': body += paraXml(b.text, '<w:spacing w:after="140"/>'); break;
      case 'hr': body += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9A84C"/></w:pBdr></w:pPr></w:p>'; break;
      case 'quote': body += paraXml(b.text, '<w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C9A84C"/></w:pBdr>', { i: true }); break;
      case 'li': {
        const left = 360 + b.indent * 360;
        const bullet = b.ordered ? `${b.num}. ` : '• ';
        body += `<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="${left}" w:hanging="300"/></w:pPr>${runXml({ t: bullet })}${parseInline(b.text).map(s => runXml(s)).join('')}</w:p>`;
        break;
      }
      case 'code':
        for (const ln of (b.text || ' ').split('\n')) {
          body += `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(ln.replace(/\t/g, '    '))}</w:t></w:r></w:p>`;
        }
        body += '<w:p/>';
        break;
      case 'table': {
        const cell = (t, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F0EDE6"/>' : ''}</w:tcPr>${paraXml(t, '', head ? { b: true } : {})}</w:tc>`;
        const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:color="BFB9A8"/>`).join('');
        body += `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
          `<w:tr>${b.header.map(c => cell(c, true)).join('')}</w:tr>` +
          b.rows.map(r => `<w:tr>${b.header.map((_, k) => cell(r[k] || '', false)).join('')}</w:tr>`).join('') + '</w:tbl><w:p/>';
        break;
      }
    }
  }

  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const heading = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 240 : 200}" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="${n === 1 ? '7A5F12' : '2B2A27'}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Nirmala UI"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading(1, 40) + heading(2, 30) + heading(3, 26) +
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F1EA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style></w:styles>`;

  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', data: doc },
    { name: 'word/styles.xml', data: styles }
  ]);
}

/* ----------------------------- XLSX ----------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

// Accepts a Markdown table, or CSV text, and returns a 2D array.
function extractTable(content) {
  const blocks = parseMarkdown(content);
  const t = blocks.find(b => b.type === 'table');
  if (t) return [t.header.map(plainInline), ...t.rows.map(r => r.map(plainInline))];
  return parseCsv(content);
}

const colName = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function toXlsx(title, content) {
  const rows = extractTable(content);
  const sheetRows = rows.map((r, ri) =>
    `<row r="${ri + 1}">` + r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      const s = String(v).trim();
      if (ri > 0 && s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return `<c r="${ref}"><v>${s}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
    }).join('') + '</row>').join('');

  const widths = [];
  rows.forEach(r => r.forEach((v, i) => { widths[i] = Math.min(Math.max(widths[i] || 8, String(v).length + 2), 60); }));
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';

  const sheetName = (String(title || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').trim() || 'Sheet1').slice(0, 31);
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0E6C8"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sheetRows}</sheetData></worksheet>` }
  ]);
}

/* ----------------------------- PDF (Helvetica / Courier, WinAnsi) ----------------------------- */

const WIN1252 = {
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96,
  '—': 0x97, '…': 0x85, '€': 0x80, '™': 0x99, ' ': 0x20
};

function pdfBytes(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (WIN1252[ch] !== undefined) out.push(WIN1252[ch]);
    else if (cp >= 32 && cp <= 126) out.push(cp);
    else if (cp >= 160 && cp <= 255) out.push(cp);
    else if (cp === 9) out.push(32, 32, 32, 32);
    else out.push(63); // '?' — standard PDF fonts can't draw Devanagari etc.
  }
  return Buffer.from(out);
}

const pdfEscape = buf => {
  let s = '';
  for (const b of buf) s += b === 40 || b === 41 || b === 92 ? '\\' + String.fromCharCode(b) : String.fromCharCode(b);
  return s;
};

// Approximate Helvetica advance widths (per 1000 em) — good enough for wrapping.
function helvWidth(ch, bold) {
  if ('iljI.,;:\'|!'.includes(ch)) return 250;
  if ('ftr()[]{}- '.includes(ch)) return 330;
  if ('mwMW'.includes(ch)) return 830;
  if (/[A-Z]/.test(ch)) return bold ? 720 : 680;
  if (/[0-9]/.test(ch)) return 556;
  return bold ? 580 : 540;
}
const textWidth = (s, size, bold) => { let w = 0; for (const ch of s) w += helvWidth(ch, bold); return (w * size) / 1000; };

function wrapText(text, maxW, size, bold) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (textWidth(test, size, bold) <= maxW) cur = test;
    else {
      if (cur) lines.push(cur);
      // hard-break very long words
      let rest = w;
      while (textWidth(rest, size, bold) > maxW) {
        let n = rest.length;
        while (n > 1 && textWidth(rest.slice(0, n), size, bold) > maxW) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      cur = rest;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function toPdf(title, md) {
  const W = 595.28, H = 841.89, M = 56;
  const maxW = W - 2 * M;
  const pages = [];
  let ops = [], y = H - M;
  const newPage = () => { if (ops.length) pages.push(ops.join('\n')); ops = []; y = H - M; };
  const ensure = h => { if (y - h < M) newPage(); };

  // fill: [r,g,b] 0..1
  const text = (s, x, yy, font, size, color = [0.12, 0.11, 0.1]) => {
    ops.push(`BT /${font} ${size} Tf ${color.join(' ')} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td (${pdfEscape(pdfBytes(s))}) Tj ET`);
  };
  const rect = (x, yy, w, h, color) => ops.push(`${color.join(' ')} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);

  const blocks = parseMarkdown(md);
  const firstIsH1 = blocks[0] && blocks[0].type === 'h' && blocks[0].level === 1;
  if (!firstIsH1 && title) blocks.unshift({ type: 'h', level: 1, text: title });

  const sizes = { 1: 22, 2: 16, 3: 13 };
  for (const b of blocks) {
    if (b.type === 'h') {
      const size = sizes[b.level];
      const lines = wrapText(plainInline(b.text), maxW, size, true);
      ensure(lines.length * size * 1.3 + 18);
      y -= b.level === 1 ? 4 : 12;
      for (const ln of lines) { y -= size * 1.25; text(ln, M, y, 'F2', size, b.level === 1 ? [0.48, 0.37, 0.07] : [0.17, 0.16, 0.15]); }
      if (b.level === 1) { y -= 6; rect(M, y, maxW, 1.5, [0.79, 0.66, 0.3]); y -= 8; } else y -= 4;
    } else if (b.type === 'p' || b.type === 'quote') {
      const size = 11, indent = b.type === 'quote' ? 14 : 0;
      const lines = wrapText(plainInline(b.text), maxW - indent, size, false);
      ensure(size * 1.5);
      for (const ln of lines) {
        ensure(size * 1.5);
        y -= size * 1.5;
        if (b.type === 'quote') rect(M, y - 3, 2.5, size * 1.5, [0.79, 0.66, 0.3]);
        text(ln, M + indent, y, b.type === 'quote' ? 'F1' : 'F1', size, b.type === 'quote' ? [0.4, 0.38, 0.35] : undefined);
      }
      y -= 6;
    } else if (b.type === 'li') {
      const size = 11, ind = 14 + b.indent * 16;
      const bullet = b.ordered ? `${b.num}.` : '•';
      const lines = wrapText(plainInline(b.text), maxW - ind - 14, size, false);
      lines.forEach((ln, k) => {
        ensure(size * 1.5);
        y -= size * 1.5;
        if (k === 0) text(bullet, M + ind - 12, y, 'F1', size);
        text(ln, M + ind + 4, y, 'F1', size);
      });
      y -= 3;
    } else if (b.type === 'hr') {
      ensure(16); y -= 8; rect(M, y, maxW, 0.8, [0.8, 0.78, 0.72]); y -= 8;
    } else if (b.type === 'code') {
      const size = 9, lh = 12.5, cw = size * 0.6, pad = 8;
      const maxChars = Math.floor((maxW - 2 * pad) / cw);
      const lines = [];
      for (const raw of (b.text || ' ').split('\n')) {
        let l = raw.replace(/\t/g, '    ');
        if (!l.length) lines.push('');
        while (l.length > maxChars) { lines.push(l.slice(0, maxChars)); l = l.slice(maxChars); }
        if (l.length) lines.push(l);
      }
      y -= 4;
      let idx = 0;
      while (idx < lines.length) {
        ensure(lh + 2 * pad);
        const fit = Math.max(1, Math.min(lines.length - idx, Math.floor((y - M - 2 * pad) / lh)));
        const h = fit * lh + 2 * pad;
        rect(M, y - h, maxW, h, [0.955, 0.945, 0.92]);
        let yy = y - pad;
        for (let k = 0; k < fit; k++) { yy -= lh; text(lines[idx + k], M + pad, yy + 3, 'F3', size, [0.16, 0.16, 0.15]); }
        y -= h; idx += fit;
        if (idx < lines.length) newPage();
      }
      y -= 8;
    } else if (b.type === 'table') {
      const cols = b.header.length, cw = maxW / cols, size = 10, pad = 5;
      const drawRow = (cells, head) => {
        const wrapped = cells.map(c => wrapText(plainInline(c || ''), cw - 2 * pad, size, head));
        const rows = Math.max(...wrapped.map(w => w.length));
        const h = rows * size * 1.35 + 2 * pad;
        ensure(h);
        if (head) rect(M, y - h, maxW, h, [0.94, 0.9, 0.78]);
        ops.push(`0.8 0.78 0.72 RG 0.5 w ${M} ${(y - h).toFixed(2)} ${maxW.toFixed(2)} ${h.toFixed(2)} re S`);
        wrapped.forEach((lines, ci) => lines.forEach((ln, k) => text(ln, M + ci * cw + pad, y - pad - size * (k + 1) * 1.3, head ? 'F2' : 'F1', size)));
        y -= h;
      };
      y -= 4;
      drawRow(b.header, true);
      b.rows.forEach(r => drawRow(b.header.map((_, i) => r[i] || ''), false));
      y -= 10;
    }
  }
  newPage();

  // Assemble PDF objects
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');       // 1
  add('PAGES');                                    // 2 (filled later)
  const fontRef = f => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`);
  fontRef('Helvetica'); fontRef('Helvetica-Bold'); fontRef('Courier'); // 3,4,5

  const pageIds = [];
  for (const content of pages) {
    const stream = Buffer.from(content, 'latin1');
    const cid = add({ stream });
    const pid = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cid} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> >>`);
    pageIds.push(pid);
  }
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title (${pdfEscape(pdfBytes(title || 'Document'))}) /Producer (Pieto) >>`);

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((o, idx) => {
    offsets.push(pos);
    let buf;
    if (typeof o === 'object') {
      buf = Buffer.concat([Buffer.from(`${idx + 1} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else buf = Buffer.from(`${idx + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    chunks.push(buf); pos += buf.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/* ----------------------------- Public API ----------------------------- */

const CODE_EXT = {
  py: 'text/x-python', js: 'text/javascript', ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript',
  java: 'text/x-java-source', kt: 'text/x-kotlin', c: 'text/x-c', cpp: 'text/x-c++src', cs: 'text/plain', go: 'text/plain',
  rs: 'text/plain', php: 'text/x-php', rb: 'text/plain', sh: 'text/x-sh', sql: 'text/plain', css: 'text/css',
  xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', swift: 'text/plain', dart: 'text/plain'
};

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json'
};

const FORMATS = [...Object.keys(MIME), ...Object.keys(CODE_EXT)];

// Strip a single wrapping ``` fence (used for raw code/json/csv files).
function unfence(s) {
  const m = String(s).trim().match(/^```[\w+#.-]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : String(s);
}

function safeName(s, fallback) {
  const n = String(s || '').replace(/[^\w\- .]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return n || fallback;
}

function generateFile({ format, title, content, filename }) {
  const fmt = String(format || 'pdf').toLowerCase().replace(/^\./, '');
  if (!FORMATS.includes(fmt)) throw Object.assign(new Error(`Unsupported format "${fmt}". Supported: ${FORMATS.join(', ')}`), { status: 400 });
  const text = String(content || '');
  if (!text.trim()) throw Object.assign(new Error('No content to put in the file.'), { status: 400 });
  const h1 = text.match(/^#\s+(.+)$/m);
  const ttl = String(title || '').trim() || (h1 && plainInline(h1[1]).trim()) || 'Document';
  const base = safeName(filename ? String(filename).replace(/\.[^.]+$/, '') : ttl, 'pieto_file');

  let data, mime = MIME[fmt] || CODE_EXT[fmt];
  switch (fmt) {
    case 'pdf': data = toPdf(ttl, text); break;
    case 'docx': data = toDocx(ttl, text); break;
    case 'xlsx': data = toXlsx(ttl, text); break;
    case 'html': data = Buffer.from(/<html[\s>]/i.test(text) ? unfence(text) : toHtml(ttl, text), 'utf8'); break;
    case 'md': data = Buffer.from(text, 'utf8'); break;
    case 'txt': data = Buffer.from(parseMarkdown(text).map(b => b.type === 'code' ? b.text : b.type === 'li' ? `${b.ordered ? b.num + '.' : '-'} ${plainInline(b.text)}` : b.type === 'table' ? [b.header, ...b.rows].map(r => r.join('\t')).join('\n') : b.type === 'hr' ? '----' : plainInline(b.text || '')).join('\n\n'), 'utf8'); break;
    case 'csv': {
      const rows = extractTable(unfence(text));
      data = Buffer.from('﻿' + rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\r\n'), 'utf8');
      break;
    }
    case 'json': {
      const raw = unfence(text);
      let out = raw;
      try { out = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) { /* keep as-is */ }
      data = Buffer.from(out, 'utf8');
      break;
    }
    default: data = Buffer.from(unfence(text), 'utf8'); // code file
  }

  return { filename: `${base}.${fmt}`, mime, buffer: data };
}

module.exports = { generateFile, FORMATS, parseMarkdown };
