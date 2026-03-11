const crypto = require('crypto');
const { calculateCost, normalizeModelName } = require('./pricing');

// ============================================================
// In-memory session store (1 hour TTL)
// ============================================================

const sessions = new Map();
const SESSION_TTL = 60 * 60 * 1000; // 1 hour

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(id);
  }
}, 5 * 60 * 1000); // check every 5 min
cleanupTimer.unref();

function createSession(data) {
  const id = crypto.randomBytes(8).toString('hex');
  sessions.set(id, { data, createdAt: Date.now() });
  return id;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(id); return null; }
  return s.data;
}

function deleteSession(id) {
  return sessions.delete(id);
}

// ============================================================
// CSV Parsing
// ============================================================

function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header — handle quoted headers
  const headers = parseCSVLine(lines[0]);

  // Column index mapping
  const col = (name) => headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const iDate = col('Date');
  const iKind = col('Kind');
  const iModel = col('Model');
  const iMaxMode = col('Max Mode');
  const iInputCacheWrite = col('Input (w/ Cache Write)');
  const iInputNoCacheWrite = col('Input (w/o Cache Write)');
  const iCacheRead = col('Cache Read');
  const iOutputTokens = col('Output Tokens');
  const iTotalTokens = col('Total Tokens');
  const iCost = col('Cost');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 3) continue;

    const dateStr = fields[iDate] || '';
    const timestamp = new Date(dateStr).getTime();
    if (isNaN(timestamp)) continue;

    const costStr = iCost >= 0 ? (fields[iCost] || '').trim() : '';
    const cost = costStr.toLowerCase() === 'included' ? null : parseFloat(costStr.replace(/^\$/, '')) || null;

    rows.push({
      timestamp,
      date: dateStr,
      model: iModel >= 0 ? (fields[iModel] || '') : '',
      kind: iKind >= 0 ? (fields[iKind] || '') : '',
      maxMode: iMaxMode >= 0 ? (fields[iMaxMode] || '') : '',
      inputCacheWrite: iInputCacheWrite >= 0 ? (parseInt(fields[iInputCacheWrite]) || 0) : 0,
      inputTokens: iInputNoCacheWrite >= 0 ? (parseInt(fields[iInputNoCacheWrite]) || 0) : 0,
      cacheRead: iCacheRead >= 0 ? (parseInt(fields[iCacheRead]) || 0) : 0,
      outputTokens: iOutputTokens >= 0 ? (parseInt(fields[iOutputTokens]) || 0) : 0,
      totalTokens: iTotalTokens >= 0 ? (parseInt(fields[iTotalTokens]) || 0) : 0,
      cost,
      estimatedCost: calculateCost(fields[iModel] || '', parseInt(fields[iInputNoCacheWrite]) || 0, parseInt(fields[iOutputTokens]) || 0, parseInt(fields[iCacheRead]) || 0, parseInt(fields[iInputCacheWrite]) || 0),
      normalizedModel: normalizeModelName(fields[iModel] || '') || null,
    });
  }

  return rows;
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ============================================================
// Matching: CSV rows ↔ Cursor sessions (two-phase)
//   Phase 1: bubble timingInfo (±30s exact match)
//   Phase 2: composer createdAt/lastUpdatedAt time ranges
// ============================================================

function matchCSVToSessions(csvRows, bubbleTimestamps, cachedChats, composerHeaders) {
  if (!csvRows.length) return { matched: [], unmatched: csvRows, sessionDetails: [] };

  // Build chat lookup map from cache
  const chatMap = {};
  if (cachedChats && Array.isArray(cachedChats)) {
    for (const c of cachedChats) {
      chatMap[c.composerId || c.id] = c;
    }
  }

  // ── Phase 1: Bubble-level timingInfo matching (±30s) ──
  const bubbles = bubbleTimestamps
    .filter(b => b.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);

  const WINDOW_MS = 30 * 1000;
  const phase1Matched = [];
  const phase1Unmatched = [];

  const sortedCSV = [...csvRows].sort((a, b) => a.timestamp - b.timestamp);

  for (const row of sortedCSV) {
    if (!bubbles.length) { phase1Unmatched.push(row); continue; }

    const target = row.timestamp;
    let lo = 0, hi = bubbles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bubbles[mid].timestamp < target) lo = mid + 1;
      else hi = mid;
    }

    let bestIdx = lo;
    let bestDiff = Math.abs(bubbles[lo].timestamp - target);
    if (lo > 0) {
      const diff = Math.abs(bubbles[lo - 1].timestamp - target);
      if (diff < bestDiff) { bestIdx = lo - 1; bestDiff = diff; }
    }

    if (bestDiff <= WINDOW_MS) {
      phase1Matched.push({ ...row, composerId: bubbles[bestIdx].composerId, bubbleModelId: bubbles[bestIdx].modelId });
    } else {
      phase1Unmatched.push(row);
    }
  }

  // ── Phase 2: Composer time-range matching for remaining rows ──
  // Build composer time ranges from composerHeaders + cachedChats
  const composers = [];
  const seen = new Set();

  // From composerHeaders (direct from workspace state — has createdAt/lastUpdatedAt)
  if (composerHeaders && Array.isArray(composerHeaders)) {
    for (const h of composerHeaders) {
      if (!h.composerId || !h.createdAt) continue;
      seen.add(h.composerId);
      composers.push({
        composerId: h.composerId,
        start: h.createdAt,
        end: h.lastUpdatedAt || h.createdAt,
      });
    }
  }

  // From cachedChats (fallback for sessions not in composerHeaders)
  for (const c of Object.values(chatMap)) {
    const id = c.composerId || c.id;
    if (seen.has(id) || !c.created_at) continue;
    composers.push({
      composerId: id,
      start: c.created_at,
      end: c.last_updated_at || c.created_at,
    });
  }

  // Sort composers by start time for efficient searching
  composers.sort((a, b) => a.start - b.start);

  const phase2Matched = [];
  const finalUnmatched = [];

  for (const row of phase1Unmatched) {
    const target = row.timestamp;

    // Find all composers whose [start, end] range covers this timestamp
    // Use a generous buffer: CSV timestamp may be slightly before session start
    // or after last update (request in progress when session was last read)
    const RANGE_BUFFER_MS = 5 * 60 * 1000; // 5 minutes buffer
    const candidates = [];

    for (const comp of composers) {
      if (target >= comp.start - RANGE_BUFFER_MS && target <= comp.end + RANGE_BUFFER_MS) {
        candidates.push(comp);
      }
    }

    if (candidates.length === 1) {
      // Exact single match
      phase2Matched.push({ ...row, composerId: candidates[0].composerId });
    } else if (candidates.length > 1) {
      // Multiple overlapping sessions — pick the one with closest midpoint
      let best = candidates[0];
      let bestDist = Math.abs(target - (best.start + best.end) / 2);
      for (let i = 1; i < candidates.length; i++) {
        const dist = Math.abs(target - (candidates[i].start + candidates[i].end) / 2);
        if (dist < bestDist) { best = candidates[i]; bestDist = dist; }
      }
      phase2Matched.push({ ...row, composerId: best.composerId });
    } else {
      finalUnmatched.push(row);
    }
  }

  // Combine all matched rows
  const matched = [...phase1Matched, ...phase2Matched];

  // Group matched rows by composerId
  const byComposer = {};
  for (const row of matched) {
    if (!byComposer[row.composerId]) byComposer[row.composerId] = [];
    byComposer[row.composerId].push(row);
  }

  // Build session details
  const sessionDetails = Object.entries(byComposer).map(([composerId, rows]) => {
    const chat = chatMap[composerId] || {};
    const models = [...new Set(rows.map(r => r.model).filter(Boolean))];
    const totalInput = rows.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutput = rows.reduce((s, r) => s + r.outputTokens, 0);
    const totalCacheRead = rows.reduce((s, r) => s + r.cacheRead, 0);
    const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
    const totalEstimatedCost = rows.reduce((s, r) => s + (r.estimatedCost || 0), 0);
    const includedCount = rows.filter(r => r.cost === null).length;

    return {
      composerId,
      name: chat.name || null,
      folder: chat.folder || null,
      models,
      requestCount: rows.length,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCost,
      totalEstimatedCost,
      includedCount,
      csvRows: rows,
    };
  }).sort((a, b) => b.totalEstimatedCost - a.totalEstimatedCost);

  return { matched, unmatched: finalUnmatched, sessionDetails };
}

// ============================================================
// Summary computation
// ============================================================

function computeSummary(matched, unmatched, sessionDetails) {
  const allRows = [...matched, ...unmatched];
  const totalRequests = allRows.length;
  const matchedCount = matched.length;
  const matchRate = totalRequests > 0 ? ((matchedCount / totalRequests) * 100) : 0;

  const totalCost = allRows.reduce((s, r) => s + (r.cost || 0), 0);
  const totalEstimatedCost = allRows.reduce((s, r) => s + (r.estimatedCost || 0), 0);
  const totalInput = allRows.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = allRows.reduce((s, r) => s + r.outputTokens, 0);
  const totalCacheRead = allRows.reduce((s, r) => s + r.cacheRead, 0);
  const includedCount = allRows.filter(r => r.cost === null).length;

  const models = [...new Set(allRows.map(r => r.model).filter(Boolean))];
  const unknownModels = [...new Set(allRows.filter(r => r.estimatedCost === null).map(r => r.model).filter(Boolean))];

  // Model breakdown
  const byModel = {};
  for (const row of allRows) {
    const m = row.model || 'unknown';
    if (!byModel[m]) byModel[m] = { model: m, normalizedModel: row.normalizedModel || null, inputTokens: 0, outputTokens: 0, cacheRead: 0, inputCacheWrite: 0, requestCount: 0, cost: 0, estimatedCost: 0, includedCount: 0 };
    byModel[m].inputTokens += row.inputTokens;
    byModel[m].outputTokens += row.outputTokens;
    byModel[m].cacheRead += row.cacheRead;
    byModel[m].inputCacheWrite += row.inputCacheWrite || 0;
    byModel[m].requestCount++;
    byModel[m].cost += row.cost || 0;
    byModel[m].estimatedCost += row.estimatedCost || 0;
    if (row.cost === null) byModel[m].includedCount++;
  }
  const modelBreakdown = Object.values(byModel).sort((a, b) => b.estimatedCost - a.estimatedCost || b.requestCount - a.requestCount);

  // Daily trend
  const byDay = {};
  for (const row of allRows) {
    const day = new Date(row.timestamp).toISOString().split('T')[0];
    if (!byDay[day]) byDay[day] = { date: day, cost: 0, estimatedCost: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
    byDay[day].cost += row.cost || 0;
    byDay[day].estimatedCost += row.estimatedCost || 0;
    byDay[day].requests++;
    byDay[day].inputTokens += row.inputTokens;
    byDay[day].outputTokens += row.outputTokens;
  }
  const dailyTrend = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalRequests,
    matchedCount,
    unmatchedCount: unmatched.length,
    matchRate: Math.round(matchRate * 10) / 10,
    totalCost,
    totalEstimatedCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    includedCount,
    uniqueModels: models.length,
    unknownModels,
    models,
    modelBreakdown,
    dailyTrend,
    sessionCount: sessionDetails ? sessionDetails.length : 0,
  };
}

module.exports = { parseCSV, matchCSVToSessions, computeSummary, createSession, getSession, deleteSession };
