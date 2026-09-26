// thinking.js — maps the configured thinking level onto provider parameters.
// ---------------------------------------------------------------------------
// Ported from the CRAG agent (qezawat-a/CRAG) src/agent/thinking.js.
//
// A reasoning parameter is only sent to models we KNOW support it, otherwise the
// API answers 400 and the whole request dies.
//
//   openai    (o-series / gpt-5) : reasoning_effort (low | medium | high)
//   anthropic (claude 3.7/4)     : thinking { type:'enabled', budget_tokens }
//   google    (gemini)           : not sent on the OpenAI-compatible route
//
// Levels: low | mid | high | xhigh | max  (low/mid = thinking off = fast & cheap)
export const levels = {
  off: { budget: 0, label: 'off' },
  low: { budget: 1024, label: 'low' },
  mid: { budget: 4096, label: 'mid' },
  high: { budget: 8192, label: 'high' },
  xhigh: { budget: 8192, label: 'xhigh' },
  max: { budget: 16384, label: 'max' },
};

export function getThinkingLevel(level) {
  return levels[level] || levels.mid;
}

export function parseThinkingLevel(raw) {
  const value = String(raw ?? '').toLowerCase().trim();
  if (value in levels) return value;
  const n = Number(value);
  if (!Number.isNaN(n)) {
    if (n <= 1024) return 'low';
    if (n <= 4096) return 'mid';
    if (n <= 8192) return 'high';
    return 'max';
  }
  return 'mid';
}

// OpenAI (Chat Completions — o-series / gpt-5)
export function openaiReasoning(level, model) {
  const m = String(model || '').toLowerCase();
  const isReasoning =
    m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('gpt-5');
  if (!isReasoning) return null;

  const effort = { low: 'low', mid: 'medium', high: 'high', xhigh: 'high', max: 'high' };
  return { reasoning_effort: effort[level] || 'medium' };
}

// Anthropic (extended thinking)
const ANTH_BUDGET = { high: 4096, xhigh: 8192, max: 16384 };

export function anthropicThinking(level, model) {
  const budget = ANTH_BUDGET[level];
  if (!budget) return null; // low/mid = thinking off (default, cheap)

  const m = String(model || '').toLowerCase();
  const capable =
    m.includes('claude') &&
    (m.includes('3-7') || m.includes('sonnet-4') || m.includes('opus-4') || /claude-(sonnet|opus)-4/.test(m));
  if (!capable) return null; // older Claude models have no extended thinking

  return { thinking: { type: 'enabled', budget_tokens: budget }, budget };
}
