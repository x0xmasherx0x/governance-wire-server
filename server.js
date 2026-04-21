// ─────────────────────────────────────────────────────────────────────────────
// The Governance Wire — server.js v2
// Render.com deployment (Node 18+)
//
// Architecture: Make.com hits POST /generate with no body.
// This server calls Claude API with web search, handles the full
// multi-turn tool-use loop, builds the .docx, converts to PDF, returns base64.
//
// Endpoints:
//   POST /generate   — triggers full pipeline, returns { pdf_base64, filename }
//   GET  /health     — health check
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const https   = require('https');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle,
  ExternalHyperlink, UnderlineType, ShadingType, WidthType,
  Table, TableRow, TableCell, PageBreak, TabStopType, LeaderType
} = require('docx');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: '4mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Call Anthropic API (handles multi-turn tool-use loop) ─────────────────────
async function callClaude() {
  const PROMPT = `You are writing a daily AI governance briefing for Jack McDermott, a Tufts University junior interning at Nielsen Holdings on the AI Governance Strategy team. Nielsen Holdings is a media measurement company (separate from NielsenIQ). Jack is building an AI governance function from scratch under Senior Director Suman Kumar Dubey.

Search the web for real AI governance news from the past 48 hours. Return ONLY a valid JSON object — no markdown, no backticks, no explanation before or after it.

Use exactly this shape:
{"date":"today's full date","sections":[{"label":"US Government & Policy","topline":"one sentence summary of biggest theme","stories":[{"tier":1,"headline":"Story headline","tag":"one of: regulation, legislation, enforcement, corporate, international, litigation, research","source":"Publication name","body":"2-3 sentence factual summary with specific names, bill numbers, dollar amounts.","so_what":"One sentence on why this matters for someone building an AI governance function at a media measurement company like Nielsen.","related":null,"sources":[{"label":"Publication: Article title","url":"https://..."}]}]},{"label":"International Governments","topline":"...","stories":[]},{"label":"Notable Corporate Actions","topline":"...","stories":[]},{"label":"Legal Disputes & Enforcement","topline":"...","stories":[]},{"label":"Research & Industry Reports","topline":"...","stories":[]}]}

Include exactly these 5 sections in order. Each section needs a topline and 2-3 stories. Tier: 1=must-read, 2=worth-knowing, 3=FYI. Each story needs 2-3 real source URLs. Be specific — name companies, bills, agencies, dollar amounts. Focus on: EU AI Act implementation, US federal/state AI legislation, corporate AI governance, FTC/regulatory enforcement, think tank research (CSET, Brookings), media/data industry AI policy.`;

  const messages = [{ role: 'user', content: PROMPT }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

  // Agentic loop — keep going until stop_reason is 'end_turn'
  for (let turn = 0; turn < 10; turn++) {
    const responseBody = await anthropicPost({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      tools,
      messages
    });

    console.log(`Turn ${turn + 1}: stop_reason=${responseBody.stop_reason}, content blocks=${responseBody.content.length}`);

    // Add assistant response to message history
    messages.push({ role: 'assistant', content: responseBody.content });

    if (responseBody.stop_reason === 'end_turn') {
      const allText = responseBody.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(' ');
      if (allText.trim()) return allText;
      throw new Error('end_turn but no text. Block types: ' + responseBody.content.map(b=>b.type).join(', '));
    }

    if (responseBody.stop_reason === 'tool_use') {
      console.log('Web search in progress, continuing...');
      continue;
    }

    throw new Error('Unexpected stop_reason: ' + responseBody.stop_reason);
  }

  throw new Error('Exceeded maximum turns in Claude tool-use loop');
}

// ── Raw HTTPS call to Anthropic API ───────────────────────────────────────────
function anthropicPost(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`Anthropic API error ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response: ' + raw.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Extract digest JSON from Claude's text response ───────────────────────────
function extractDigest(text) {
  // Try multiple strategies to find valid digest JSON
  const candidates = [text];
  // Also try stripping markdown fences
  candidates.push(text.replace(/^```json\s*/im, '').replace(/```\s*$/im, '').trim());

  for (const candidate of candidates) {
    // Find all { } blocks and try each, preferring the last one with sections
    let pos = 0;
    let best = null;
    while (pos < candidate.length) {
      const start = candidate.indexOf('{', pos);
      if (start === -1) break;
      const end = candidate.lastIndexOf('}');
      if (end <= start) break;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
          best = parsed;
        }
      } catch(e) {}
      pos = start + 1;
    }
    if (best) return best;
  }
  throw new Error('No valid digest JSON found. Text preview: ' + text.substring(0, 300));
}

// ── POST /generate ────────────────────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY environment variable not set');

    console.log('Starting Claude API call with web search...');
    const claudeText = await callClaude();
    console.log('Claude response received, extracting digest...');

    const digest = extractDigest(claudeText);
    console.log(`Digest extracted: ${digest.sections.length} sections`);

    const docBuffer = await buildDoc(digest);
    console.log('Doc built, converting to PDF...');

    const pdfBuffer = await convertToPdf(docBuffer);
    console.log('PDF ready, sending response...');

    res.json({
      pdf_base64: pdfBuffer.toString('base64'),
      filename: `governance-wire-${(digest.date || 'today').replace(/[^a-z0-9-]/gi, '-')}.pdf`
    });

  } catch (err) {
    console.error('Pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PDF conversion via LibreOffice ────────────────────────────────────────────
function convertToPdf(docxBuffer) {
  return new Promise((resolve, reject) => {
    const { execSync, spawnSync } = require('child_process');
    const os   = require('os');
    const path = require('path');
    const fs   = require('fs');

    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'gwire-'));
    const docxPath = path.join(tmpDir, 'brief.docx');
    const pdfPath  = path.join(tmpDir, 'brief.pdf');

    try {
      fs.writeFileSync(docxPath, docxBuffer);

      // LibreOffice is available on Render's Linux environment
      const result = spawnSync('libreoffice', [
        '--headless',
        '--convert-to', 'pdf',
        '--outdir', tmpDir,
        docxPath
      ], { timeout: 60000 });

      if (result.status !== 0) {
        throw new Error('LibreOffice conversion failed: ' + (result.stderr?.toString() || 'unknown error'));
      }

      const pdfBuffer = fs.readFileSync(pdfPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve(pdfBuffer);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      reject(err);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Document builder — takes Claude's JSON digest and returns a docx Buffer
// ─────────────────────────────────────────────────────────────────────────────

const sectionMeta = {
  "US Government & Policy":       { accent: "1E4D8C", bar: "1E4D8C" },
  "International Governments":    { accent: "1A6B4A", bar: "1A6B4A" },
  "Notable Corporate Actions":    { accent: "C47A1A", bar: "C47A1A" },
  "Legal Disputes & Enforcement": { accent: "6B2380", bar: "6B2380" },
  "Research & Industry Reports":  { accent: "4A4A4A", bar: "4A4A4A" },
};

const tagColors = {
  regulation:    { bg: "F5E8E6", text: "8C2A1C" },
  enforcement:   { bg: "F5E8E6", text: "8C2A1C" },
  legislation:   { bg: "F5E8E6", text: "8C2A1C" },
  litigation:    { bg: "F0E8F4", text: "6B2380" },
  corporate:     { bg: "FFF0E0", text: "8A4A00" },
  international: { bg: "E6F3EC", text: "1A5C38" },
  research:      { bg: "EEEEEE", text: "333333" },
  policy:        { bg: "F5E8E6", text: "8C2A1C" },
};

const TIER_LABELS = { 1: "Must-read", 2: "Worth knowing", 3: "FYI" };
const TIER_COLORS = { 1: "8C2A1C", 2: "C47A1A", 3: "888888" };
const TIER_DOTS   = { 1: "●●●",    2: "●●○",   3: "●○○"   };

// ── Helpers ───────────────────────────────────────────────────────────────────

function hairline(color = "E0DDD8", size = 4) {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size, color, space: 1 } },
    spacing: { before: 0, after: 0 },
    children: []
  });
}

function gap(after = 160) {
  return new Paragraph({ spacing: { before: 0, after }, children: [new TextRun("")] });
}

function singleCellTable(innerChildren, fill = "F5F2EE", leftBorderColor = null) {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [new TableRow({
      children: [new TableCell({
        borders: {
          top: none, bottom: none, right: none,
          left: leftBorderColor
            ? { style: BorderStyle.SINGLE, size: 16, color: leftBorderColor, space: 0 }
            : none,
        },
        shading: { type: ShadingType.CLEAR, fill },
        margins: { top: 100, bottom: 100, left: leftBorderColor ? 180 : 140, right: 140 },
        width: { size: 9360, type: WidthType.DXA },
        children: innerChildren,
      })]
    })]
  });
}

function tagRun(tag) {
  const c = tagColors[tag] || { bg: "EEEEEE", text: "444444" };
  return new TextRun({
    text: ` ${tag.toUpperCase()} `,
    font: "Arial", size: 15, bold: true,
    color: c.text,
    shading: { type: ShadingType.CLEAR, fill: c.bg },
  });
}

// ── Summary block (one topline per section) ───────────────────────────────────

function summaryBlock(sections) {
  const blocks = [
    gap(200),
    new Paragraph({
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: "TODAY AT A GLANCE", font: "Arial", size: 17, bold: true, color: "111111", characterSpacing: 100 })]
    }),
    hairline("DDDDDD", 3),
    gap(80),
  ];

  for (const section of sections) {
    const meta = sectionMeta[section.label] || { accent: "4A4A4A", bar: "4A4A4A" };
    blocks.push(new Paragraph({
      spacing: { before: 80, after: 80 },
      indent: { left: 240 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: meta.bar, space: 8 } },
      children: [
        new TextRun({ text: section.label.toUpperCase() + "  ", font: "Arial", size: 16, bold: true, color: meta.accent }),
        new TextRun({ text: section.topline || "", font: "Arial", size: 19, color: "333333" }),
      ]
    }));
  }

  blocks.push(gap(80));
  blocks.push(hairline("DDDDDD", 3));
  return blocks;
}

// ── Story index / TOC ─────────────────────────────────────────────────────────

function tocBlock(sections) {
  const blocks = [
    gap(240),
    new Paragraph({
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: "STORY INDEX", font: "Arial", size: 17, bold: true, color: "111111", characterSpacing: 100 })]
    }),
    hairline("DDDDDD", 3),
    gap(80),
  ];

  let num = 1;
  for (const section of sections) {
    const meta = sectionMeta[section.label] || { accent: "4A4A4A" };
    blocks.push(new Paragraph({
      spacing: { before: 120, after: 40 },
      children: [new TextRun({ text: section.label.toUpperCase(), font: "Arial", size: 15, bold: true, color: meta.accent, characterSpacing: 60 })]
    }));
    for (const story of section.stories) {
      const tier = story.tier || 3;
      blocks.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 180 },
        tabStops: [{ type: TabStopType.RIGHT, position: 9000, leader: LeaderType.DOT }],
        children: [
          new TextRun({ text: `${num}.  `, font: "Arial", size: 17, color: "AAAAAA" }),
          new TextRun({ text: story.headline, font: "Arial", size: 17, color: "222222" }),
          new TextRun({ text: `\t`, font: "Arial", size: 17 }),
          new TextRun({ text: ` ${TIER_DOTS[tier]}`, font: "Arial", size: 15, color: TIER_COLORS[tier] }),
        ]
      }));
      num++;
    }
  }

  blocks.push(gap(100));
  blocks.push(new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({ text: "Significance:  ", font: "Arial", size: 15, color: "AAAAAA" }),
      new TextRun({ text: "●●●  Must-read    ", font: "Arial", size: 15, color: TIER_COLORS[1] }),
      new TextRun({ text: "●●○  Worth knowing    ", font: "Arial", size: 15, color: TIER_COLORS[2] }),
      new TextRun({ text: "●○○  FYI", font: "Arial", size: 15, color: TIER_COLORS[3] }),
    ]
  }));
  blocks.push(gap(80));
  blocks.push(hairline("DDDDDD", 3));
  return blocks;
}

// ── Section header ────────────────────────────────────────────────────────────

function sectionHeader(label) {
  const meta = sectionMeta[label] || { accent: "4A4A4A" };
  return [
    gap(300),
    new Paragraph({
      spacing: { before: 0, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: meta.accent, space: 6 } },
      children: [new TextRun({ text: label.toUpperCase(), font: "Arial", size: 17, bold: true, color: meta.accent, characterSpacing: 80 })]
    }),
    gap(60),
  ];
}

// ── Story block ───────────────────────────────────────────────────────────────

function storyBlocks(story, num) {
  const tier       = story.tier || 3;
  const tierColor  = TIER_COLORS[tier];
  const tierLabel  = TIER_LABELS[tier];
  const tierDots   = TIER_DOTS[tier];
  const blocks     = [];

  // Meta: number + tag + source + tier badge
  blocks.push(new Paragraph({
    spacing: { before: 220, after: 80 },
    tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
    children: [
      new TextRun({ text: `${num}.  `, font: "Arial", size: 16, color: "CCCCCC", bold: true }),
      tagRun(story.tag || "policy"),
      new TextRun({ text: `   ${story.source}`, font: "Arial", size: 16, italics: true, color: "999999" }),
      new TextRun({ text: `\t`, font: "Arial", size: 16 }),
      new TextRun({ text: `${tierDots} ${tierLabel}`, font: "Arial", size: 15, bold: true, color: tierColor }),
    ]
  }));

  // Headline
  blocks.push(new Paragraph({
    spacing: { before: 0, after: 100 },
    children: [new TextRun({ text: story.headline, font: "Arial", size: 26, bold: true, color: "111111" })]
  }));

  // Body
  blocks.push(new Paragraph({
    spacing: { before: 0, after: 140 },
    children: [new TextRun({ text: story.body, font: "Arial", size: 21, color: "333333" })]
  }));

  // Nielsen relevance box
  blocks.push(singleCellTable([
    new Paragraph({
      spacing: { before: 0, after: 0 },
      children: [
        new TextRun({ text: "Nielsen relevance — ", font: "Arial", size: 19, bold: true, color: "8C2A1C" }),
        new TextRun({ text: story.so_what, font: "Arial", size: 19, color: "444444" }),
      ]
    })
  ], "F9F5F2", "C8412A"));

  blocks.push(gap(100));

  // Related story note
  if (story.related) {
    blocks.push(new Paragraph({
      spacing: { before: 0, after: 100 },
      children: [
        new TextRun({ text: "↔  ", font: "Arial", size: 17, color: "AAAAAA" }),
        new TextRun({ text: story.related, font: "Arial", size: 17, italics: true, color: "888888" }),
      ]
    }));
  }

  // Source links
  const srcChildren = [
    new TextRun({ text: "Sources:  ", font: "Arial", size: 16, bold: true, color: "AAAAAA" }),
  ];
  (story.sources || []).forEach((src, i) => {
    if (i > 0) srcChildren.push(new TextRun({ text: "   ·   ", font: "Arial", size: 16, color: "CCCCCC" }));
    srcChildren.push(new ExternalHyperlink({
      link: src.url,
      children: [new TextRun({ text: src.label, font: "Arial", size: 16, color: "1A4A8A", underline: { type: UnderlineType.SINGLE, color: "1A4A8A" } })]
    }));
  });
  blocks.push(new Paragraph({ spacing: { before: 0, after: 0 }, children: srcChildren }));

  blocks.push(gap(120));
  blocks.push(hairline("EDEBE8", 3));
  blocks.push(gap(40));

  return blocks;
}

// ── Main doc builder ──────────────────────────────────────────────────────────

async function buildDoc(digest) {
  const { date, sections } = digest;
  const children = [];
  const totalStories = sections.reduce((a, s) => a + (s.stories || []).length, 0);

  // Masthead
  children.push(new Paragraph({
    spacing: { before: 0, after: 60 },
    children: [new TextRun({ text: "Personal Intelligence Brief", font: "Arial", size: 16, color: "AAAAAA", characterSpacing: 60 })]
  }));
  children.push(new Paragraph({
    spacing: { before: 0, after: 60 },
    children: [
      new TextRun({ text: "The ", font: "Arial", size: 52, color: "111111" }),
      new TextRun({ text: "Governance", font: "Arial", size: 52, bold: true, color: "111111" }),
      new TextRun({ text: " Wire", font: "Arial", size: 52, color: "111111" }),
    ]
  }));
  children.push(new Paragraph({
    spacing: { before: 0, after: 180 },
    children: [new TextRun({ text: "AI Policy  ·  Corporate Accountability  ·  Regulatory Affairs", font: "Arial", size: 17, color: "AAAAAA" })]
  }));
  children.push(hairline("111111", 16));

  // Edition bar
  children.push(new Paragraph({
    spacing: { before: 100, after: 100 },
    children: [
      new TextRun({ text: date, font: "Arial", size: 16, color: "888888" }),
      new TextRun({ text: "     ·     ", font: "Arial", size: 16, color: "CCCCCC" }),
      new TextRun({ text: "Curated for Jack McDermott, Nielsen Holdings AI Governance", font: "Arial", size: 16, color: "888888" }),
      new TextRun({ text: "     ·     ", font: "Arial", size: 16, color: "CCCCCC" }),
      new TextRun({ text: `${totalStories} stories`, font: "Arial", size: 16, color: "888888" }),
    ]
  }));
  children.push(hairline("DDDDDD", 4));

  // Summary + TOC
  for (const b of summaryBlock(sections)) children.push(b);
  for (const b of tocBlock(sections))     children.push(b);

  // Page break
  children.push(new Paragraph({ spacing: { before: 0, after: 0 }, children: [new PageBreak()] }));

  // Stories
  let num = 1;
  for (const section of sections) {
    for (const p of sectionHeader(section.label)) children.push(p);
    for (const story of (section.stories || [])) {
      for (const b of storyBlocks(story, num)) children.push(b);
      num++;
    }
  }

  // Footer
  children.push(gap(120));
  children.push(hairline("111111", 12));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 0 },
    children: [new TextRun({
      text: `The Governance Wire  ·  ${date}  ·  Generated via Claude API + live web search`,
      font: "Arial", size: 16, italics: true, color: "BBBBBB",
    })]
  }));

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 21, color: "333333" } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1260, bottom: 1080, left: 1260 }
        }
      },
      children
    }]
  });

  return Packer.toBuffer(doc);
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Governance Wire server running on port ${PORT}`));
