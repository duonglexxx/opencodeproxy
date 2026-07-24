// server.js - OpenAI to OpenCode Zen Proxy (Universal Fix)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const ZEN_API_BASE = process.env.ZEN_API_BASE || 'https://opencode.ai/zen/v1';
const ZEN_API_KEY = process.env.ZEN_API_KEY;

const MODEL_MAPPING = {
  'big-pickle': 'big-pickle',
  'deepseek-v4-flash-free': 'deepseek-v4-flash-free',
  'mimo-v2.5-free': 'mimo-v2.5-free',
  'laguna-s-2.1-free': 'laguna-s-2.1-free',
  'north-mini-code-free': 'north-mini-code-free',
  'nemotron-3-ultra-free': 'nemotron-3-ultra-free'
};

const MODEL_LIST = Object.keys(MODEL_MAPPING).map(model => ({
  id: model,
  object: 'model',
  created: Math.floor(Date.now() / 1000),
  owned_by: 'opencode-free-proxy',
  permission: []
}));

// ===== HÀM CHUẨN HÓA CONTENT =====
function extractContent(message) {
  // Thử các field theo thứ tự ưu tiên
  const fields = [
    message.content,
    message.reasoning,
    message.reasoning_content,
    message.text,
    message.response,
    message.output
  ];
  
  // Lấy field đầu tiên có giá trị
  for (const field of fields) {
    if (field && typeof field === 'string' && field.trim().length > 0) {
      return field.trim();
    }
  }
  
  // Nếu là object, thử chuyển thành text
  if (message.content && typeof message.content === 'object') {
    try {
      return JSON.stringify(message.content);
    } catch (e) {
      return 'Content in object format';
    }
  }
  
  return null;
}

// ===== HÀM CHUẨN HÓA RESPONSE =====
function normalizeResponse(data, originalModel) {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  
  // 1. Trích xuất content từ nhiều nguồn
  let content = extractContent(message);
  
  // 2. Nếu không có content, thử lấy từ delta (streaming đã gộp)
  if (!content && data.choices?.[0]?.delta) {
    content = extractContent(data.choices[0].delta);
  }
  
  // 3. Nếu vẫn không có, tạo fallback
  if (!content) {
    content = "I'm here to help! What would you like to know?";
  }
  
  // 4. Xóa tất cả các field không cần thiết
  const cleanMessage = {
    role: 'assistant',
    content: content
  };
  
  // 5. Tạo response chuẩn OpenAI
  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || 'mimo-v2.5-free',
    choices: [{
      index: 0,
      message: cleanMessage,
      finish_reason: choice.finish_reason || 'stop'
    }],
    usage: data.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

// ===== HÀM CHUẨN HÓA STREAM =====
function normalizeStreamDelta(delta) {
  // Trích xuất content từ nhiều nguồn
  let content = extractContent(delta);
  
  // Tạo delta mới chỉ có content
  return {
    content: content || ' '
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    models: Object.keys(MODEL_MAPPING).length,
    api_key: !!ZEN_API_KEY
  });
});

// List models
app.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: MODEL_LIST });
});

// Chat completions
app.post('/v1/chat/completions', async (req, res) => {
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
    // Lấy model
    let zenModel = MODEL_MAPPING[model];
    if (!zenModel) {
      if (model?.startsWith('opencode/')) {
        zenModel = MODEL_MAPPING[model.replace('opencode/', '')];
      }
      zenModel = zenModel || 'mimo-v2.5-free';
    }

    // Tự động điều chỉnh max_tokens dựa trên model
    let requestMaxTokens = Math.min(max_tokens || 1024, 4096);
    if (zenModel === 'deepseek-v4-flash-free') {
      requestMaxTokens = Math.min(max_tokens || 2048, 8192);
    }

    // Gọi API
    const response = await axios.post(
      `${ZEN_API_BASE}/chat/completions`,
      {
        model: zenModel,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: requestMaxTokens,
        stream: stream || false,
        reasoning_effort: 'none'
      },
      {
        headers: {
          'Authorization': `Bearer ${ZEN_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000,
        responseType: stream ? 'stream' : 'json',
        validateStatus: status => status < 500
      }
    );

    if (stream) {
      return handleStream(response, res, model);
    }

    return handleResponse(response.data, res, model);

  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Server error';
    res.status(status).json({ error: { message, type: 'api_error' } });
  }
});

// ===== STREAMING HANDLER =====
function handleStream(response, res, originalModel) {
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
          // Chuẩn hóa delta - chỉ giữ content
          const normalizedDelta = normalizeStreamDelta(delta);
          
          // Tạo data mới với delta đã chuẩn hóa
          const normalizedData = {
            ...data,
            choices: [{
              ...data.choices[0],
              delta: {
                role: 'assistant',
                content: normalizedDelta.content
              }
            }]
          };
          
          res.write(`data: ${JSON.stringify(normalizedData)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      } catch {
        res.write(`${line}\n`);
      }
    }
  });

  response.data.on('end', () => res.end());
  response.data.on('error', () => res.end());
}

// ===== NON-STREAMING HANDLER =====
function handleResponse(data, res, originalModel) {
  // Chuẩn hóa response
  const normalized = normalizeResponse(data, originalModel);
  res.json(normalized);
}

// 404 handler
app.all('*', (req, res) => {
  res.status(404).json({ 
    error: { message: 'Endpoint not found', type: 'invalid_request_error' } 
  });
});

module.exports = app;