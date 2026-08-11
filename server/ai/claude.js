'use strict';
// AI adapter — the one place that talks to the Claude API. Same philosophy as
// payments and mail: OFF by default, everything falls back to the template
// engines, tests inject a fake client. The API key never leaves the server.
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../db');
const config = require('../config');

let realClient = null;
let testClient = null;

function aiAvailable() {
  return !!(config.AI_ENABLED && (config.ANTHROPIC_API_KEY || testClient));
}

function getClient() {
  if (testClient) return testClient;
  if (!realClient) realClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return realClient;
}

// test hook (not a public API)
function setClientForTests(client) {
  testClient = client;
  realClient = null;
}

// Per-event cost guard: every API call consumes one unit of the event's
// budget. Returns false when the cap is spent (callers fall back to templates).
function tryConsumeAiBudget(eventId) {
  const res = db
    .prepare(`UPDATE events SET aiCalls = aiCalls + 1 WHERE id = ? AND aiCalls < ?`)
    .run(eventId, config.AI_CALL_CAP);
  return res.changes === 1;
}

/** One text-generation call. Throws on refusal/failure — callers catch and fall back. */
async function generateText({ system, prompt, maxTokens = 4096 }) {
  const response = await getClient().messages.create({
    model: config.AI_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('AI declined the request.');
  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('AI returned no text.');
  return text;
}

/** One structured-output call. Returns the parsed object; throws on refusal/failure. */
async function generateJSON({ system, prompt, schema, maxTokens = 4096 }) {
  const response = await getClient().messages.create({
    model: config.AI_MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('AI declined the request.');
  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return JSON.parse(text);
}

/** One raw messages call (for the tool-use loop). */
function createMessage(params) {
  return getClient().messages.create({ model: config.AI_MODEL, ...params });
}

module.exports = {
  aiAvailable,
  tryConsumeAiBudget,
  generateText,
  generateJSON,
  createMessage,
  setClientForTests,
};
