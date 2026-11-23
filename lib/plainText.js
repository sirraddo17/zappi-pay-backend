// AI models often answer in Markdown (**bold**, "- " bullets, "# "
// headings). Emails, push notifications and messages to customers aren't
// Markdown, so turn it into real formatting (HTML) or clean plain text.

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Plain text: marks removed, bullets kept as "•".
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s.,;:!?)]|$)/gm, '$1$2')
    .replace(/(^|[\s(])_(\S[^_\n]*?)_(?=[\s.,;:!?)]|$)/gm, '$1$2')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Safe HTML for emails (escaped first, then bold/italic/bullets/headings).
function markdownToHtml(text) {
  return String(text || '').replace(/\r/g, '').trim().split('\n').map((raw) => {
    let line = esc(raw);
    const heading = /^#{1,6}\s+/.test(line);
    line = line.replace(/^#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1• ');
    line = line
      .replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>')
      .replace(/__([^_]+?)__/g, '<b>$1</b>')
      .replace(/`([^`]+?)`/g, '$1')
      .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s.,;:!?)]|$)/g, '$1<i>$2</i>')
      .replace(/\*\*/g, '');
    return heading ? `<b>${line}</b>` : line;
  }).join('\n');
}

module.exports = { stripMarkdown, markdownToHtml };
