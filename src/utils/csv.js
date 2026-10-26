export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Stop spreadsheet formula injection: =, +, -, @ at the start of text become plain text
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => esc(r[c.key])).join(','));
  return '\uFEFF' + [header, ...lines].join('\r\n'); // BOM so Excel reads UTF-8 names correctly
}