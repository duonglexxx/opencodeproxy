// server.js - OpenAI to OpenCode Zen Proxy (Complete Fix)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Configuration
const ZEN_API_BASE = process.env.ZEN_API_BASE || 'https://opencode.ai/zen/v1';
const ZEN_API_KEY = process.env.ZEN_API_KEY;

// Danh sách model FREE - Tên đầy đủ
const MODEL_MAPPING = {
  'big-pickle': 'big-pickle',
  'deepseek-v4-flash-free': 'deepseek-v4-flash-free',
  'mimo-v2.5-free': 'mimo-v2.5-free',
  'laguna-s-2.1-free': 'laguna-s-2.1-free',
  'north-mini-code-free': 'north-mini-code-free',
  'nemotron-3-ultra-free': 'nemotron-3-ultra-free'
};

// Cache model list
const MODEL_LIST = Object.keys(MODEL_MAPPING).map(model => ({
  id: model,
  object: 'model',
  created: Math.floor(Date.now() / 1000),
  owned_by: 'opencode-free-proxy',
  permission: []
}));

// ============ ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenCode Zen Proxy',
    version: '3.0.0',
    models: Object.keys(MODEL_MAPPING).length,
    api_key_configured: !!ZEN_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// List models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: MODEL_LIST
  });
});

// Main chat completions
app.post('/v1/chat/completions', async (req, res) => {
  // Validate API key
  if (!ZEN_API_KEY) {
    return res.status(500).json({
      error: {
        message: 'ZEN_API_KEY is not configured',
        type: 'server_error',
        code: 500
      }
    });
  }

  const { model, messages, temperature, max_tokens, stream } = req.body;

  // Validate messages
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Messages is required and must be a non-empty array',
        type: 'invalid_request_error',
        code: 400
      }
    });
  }

  try {
    // Lấy model ID
    let zenModel = getModelId(model);

    console.log(`[Proxy] Model: ${model || 'default'} -> ${zenModel}`);

    // Tạo request với reasoning disabled
    const zenRequest = {
      model: zenModel,
      messages: messages,
      temperature: temperature ?? 0.7,
      max_tokens: Math.min(max_tokens || 2048, 8192),
      stream: stream || false,
      reasoning_effort: 'none' // Tắt reasoning để tiết kiệm token
    };

    // Gọi OpenCode Zen API
    const response = await axios.post(
      `${ZEN_API_BASE}/chat/completions`,
      zenRequest,
      {
        headers: {
          'Authorization': `Bearer ${ZEN_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json'
        },
        timeout: 60000,
        responseType: stream ? 'stream' : 'json',
        validateStatus: status => status < 500
      }
    );

    // Xử lý response
    if (stream) {
      return handleStreamingResponse(response, res);
    }

    return handleNonStreamingResponse(response.data, res, model);

  } catch (error) {
    console.error('[Proxy Error]', error.message);
    if (error.response) {
      console.error('[Proxy Error Response]', JSON.stringify(error.response.data, null, 2));
    }

    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error?.message || error.message || 'Internal server error';

    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type: 'api_error',
        code: statusCode
      }
    });
  }
});

// 404 handler
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// ============ HELPER FUNCTIONS ============

// Lấy model ID từ tên model
function getModelId(model) {
  if (!model) return 'mimo-v2.5-free';

  // Kiểm tra trong mapping
  if (MODEL_MAPPING[model]) {
    return MODEL_MAPPING[model];
  }

  // Xử lý nếu có prefix "opencode/"
  if (model.startsWith('opencode/')) {
    const withoutPrefix = model.replace('opencode/', '');
    if (MODEL_MAPPING[withoutPrefix]) {
      return MODEL_MAPPING[withoutPrefix];
    }
    return withoutPrefix;
  }

  // Fallback: thử tìm kiếm gần đúng
  const lower = model.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek-v4-flash-free';
  if (lower.includes('mimo')) return 'mimo-v2.5-free';
  if (lower.includes('laguna')) return 'laguna-s-2.1-free';
  if (lower.includes('north')) return 'north-mini-code-free';
  if (lower.includes('nemotron')) return 'nemotron-3-ultra-free';
  if (lower.includes('pickle')) return 'big-pickle';

  // Default
  return 'mimo-v2.5-free';
}

// Xử lý Streaming Response
function handleStreamingResponse(response, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let buffer = '';

  response.data.on('data', (chunk) => {
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
          // Lấy content từ nhiều nguồn
          let content = delta.content || '';
          if (!content) {
            content = delta.reasoning || delta.reasoning_content || '';
          }
          delta.content = content;

          // Xóa tất cả reasoning fields
          delete delta.reasoning;
          delete delta.reasoning_content;
          delete delta.reasoning_details;
          delete delta.refusal;
        }

        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        // Nếu parse lỗi, viết nguyên dòng
        res.write(`${line}\n`);
      }
    }
  });

  response.data.on('end', () => {
    res.end();
  });

  response.data.on('error', (error) => {
    console.error('[Stream Error]', error.message);
    res.end();
  });
}

// Xử lý Non-Streaming Response
function handleNonStreamingResponse(data, res, originalModel) {
  const message = data.choices?.[0]?.message || {};

  // Lấy content từ nhiều nguồn
  let content = message.content || '';
  if (!content) {
    content = message.reasoning || message.reasoning_content || '';
  }
  if (!content) {
    content = 'The model did not generate a response. Please try again.';
  }

  // Xóa tất cả reasoning fields
  delete message.reasoning;
  delete message.reasoning_content;
  delete message.reasoning_details;
  delete message.refusal;

  // Transform response về đúng format OpenAI
  const transformed = {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || 'mimo-v2.5-free',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content
        },
        finish_reason: data.choices?.[0]?.finish_reason || 'stop'
      }
    ],
    usage: data.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  res.json(transformed);
}

// ============ EXPORT ============
module.exports = app;