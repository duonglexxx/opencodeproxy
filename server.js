// server.js - OpenAI to OpenCode Zen Proxy (Ultra Optimized)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Tối ưu: Giới hạn middleware chỉ cần thiết
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Giảm limit xuống 1mb

// Configuration
const ZEN_API_BASE = process.env.ZEN_API_BASE || 'https://opencode.ai/zen/v1';
const ZEN_API_KEY = process.env.ZEN_API_KEY;

// Chỉ giữ tên model đầy đủ
const MODEL_MAPPING = {
  'big-pickle': 'big-pickle',
  'deepseek-v4-flash-free': 'deepseek-v4-flash-free',
  'mimo-v2.5-free': 'mimo-v2.5-free',
  'laguna-s-2.1-free': 'laguna-s-2.1-free',
  'north-mini-code-free': 'north-mini-code-free',
  'nemotron-3-ultra-free': 'nemotron-3-ultra-free'
};

// Cache model list để không tạo lại mỗi request
const MODEL_LIST = Object.keys(MODEL_MAPPING).map(model => ({
  id: model,
  object: 'model',
  created: Math.floor(Date.now() / 1000),
  owned_by: 'opencode-free-proxy',
  permission: []
}));

// Health check - Nhẹ nhất có thể
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    models: Object.keys(MODEL_MAPPING).length,
    api_key: !!ZEN_API_KEY
  });
});

// List models - Dùng cache
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: MODEL_LIST
  });
});

// Chat completions - Tối ưu
app.post('/v1/chat/completions', async (req, res) => {
  // Validate nhanh
  if (!ZEN_API_KEY) {
    return res.status(500).json({ 
      error: { message: 'Missing API key', type: 'server_error' } 
    });
  }

  const { model, messages, temperature, max_tokens, stream } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ 
      error: { message: 'Messages required', type: 'invalid_request_error' } 
    });
  }

  try {
    // Lấy model - tối giản
    let zenModel = MODEL_MAPPING[model];
    if (!zenModel) {
      if (model?.startsWith('opencode/')) {
        zenModel = MODEL_MAPPING[model.replace('opencode/', '')];
      }
      zenModel = zenModel || 'mimo-v2.5-free';
    }

    // Tối ưu: Giảm timeout và limit
    const response = await axios.post(
      `${ZEN_API_BASE}/chat/completions`,
      {
        model: zenModel,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: Math.min(max_tokens || 1024, 4096), // Giảm max tokens
        stream: stream || false,
        reasoning_effort: 'none' // Tắt reasoning
      },
      {
        headers: {
          'Authorization': `Bearer ${ZEN_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000, // Giảm timeout xuống 60s
        responseType: stream ? 'stream' : 'json',
        validateStatus: status => status < 500
      }
    );

    if (stream) {
      return handleStream(response, res);
    }

    return handleResponse(response.data, res, model);

  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Server error';
    res.status(status).json({ error: { message, type: 'api_error' } });
  }
});

// Streaming handler - Tối giản
function handleStream(response, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let buffer = '';

  response.data.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      if (line.includes('[DONE]')) {
        res.write('data: [DONE]\n\n');
        continue;
      }

      try {
        const data = JSON.parse(line.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta) {
          // Lấy content, fallback từ reasoning
          delta.content = delta.content || delta.reasoning || '';
          delete delta.reasoning;
          delete delta.reasoning_details;
          delete delta.refusal;
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        res.write(`${line}\n`);
      }
    }
  });

  response.data.on('end', () => res.end());
  response.data.on('error', () => res.end());
}

// Response handler - Tối giản
function handleResponse(data, res, originalModel) {
  const message = data.choices?.[0]?.message || {};
  const content = message.content || message.reasoning || 'No response';

  res.json({
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || 'mimo-v2.5-free',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: data.choices?.[0]?.finish_reason || 'stop'
    }],
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  });
}

// 404 handler
app.all('*', (req, res) => {
  res.status(404).json({ 
    error: { message: 'Endpoint not found', type: 'invalid_request_error' } 
  });
});

module.exports = app;