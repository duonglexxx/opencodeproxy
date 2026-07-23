// server.js - OpenAI to OpenCode Zen Proxy (FREE Models - Fixed)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configuration
const ZEN_API_BASE = process.env.ZEN_API_BASE || 'https://opencode.ai/zen/v1';
const ZEN_API_KEY = process.env.ZEN_API_KEY;

// Model mapping - Chỉ các model FREE
const MODEL_MAPPING = {
  'big-pickle': 'big-pickle',
  'deepseek-free': 'deepseek-v4-flash-free',
  'mimo-free': 'mimo-v2.5-free',
  'laguna-free': 'laguna-s-2.1-free',
  'north-free': 'north-mini-code-free',
  'nemotron-free': 'nemotron-3-ultra-free',
  
  // Tên đầy đủ
  'deepseek-v4-flash-free': 'deepseek-v4-flash-free',
  'mimo-v2.5-free': 'mimo-v2.5-free',
  'laguna-s-2.1-free': 'laguna-s-2.1-free',
  'north-mini-code-free': 'north-mini-code-free',
  'nemotron-3-ultra-free': 'nemotron-3-ultra-free'
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to OpenCode Zen Proxy',
    version: '1.1.0',
    available_models: Object.keys(MODEL_MAPPING),
    api_key_configured: !!ZEN_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// List models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'opencode-free-proxy',
    permission: []
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// Main chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    if (!ZEN_API_KEY) {
      return res.status(500).json({
        error: {
          message: 'ZEN_API_KEY is not configured',
          type: 'server_error',
          code: 500
        }
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages is required and must be a non-empty array',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    let zenModel = getModelMapping(model);
    
    console.log(`[Proxy] Model: ${model} -> ${zenModel}`);

    // Tăng max_tokens để tránh finish_reason: "length"
    const zenRequest = {
      model: zenModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: Math.min(max_tokens || 2048, 16384), // Tăng lên 2048 để có response dài hơn
      stream: stream || false
    };

    const response = await axios.post(
      `${ZEN_API_BASE}/chat/completions`,
      zenRequest,
      {
        headers: {
          'Authorization': `Bearer ${ZEN_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json'
        },
        timeout: 120000,
        responseType: stream ? 'stream' : 'json',
        validateStatus: (status) => status < 500
      }
    );

    if (stream) {
      return handleStreamingResponse(response, res);
    }

    return handleNonStreamingResponse(response, res, model);

  } catch (error) {
    console.error('Proxy error:', error.message);
    if (error.response) {
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
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

function getModelMapping(model) {
  if (!model) return 'mimo-v2.5-free';
  
  if (MODEL_MAPPING[model]) return MODEL_MAPPING[model];

  if (model.startsWith('opencode/')) {
    const withoutPrefix = model.replace('opencode/', '');
    if (MODEL_MAPPING[withoutPrefix]) return MODEL_MAPPING[withoutPrefix];
    return withoutPrefix;
  }

  const lower = model.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek-v4-flash-free';
  if (lower.includes('mimo')) return 'mimo-v2.5-free';
  if (lower.includes('laguna')) return 'laguna-s-2.1-free';
  if (lower.includes('north')) return 'north-mini-code-free';
  if (lower.includes('nemotron')) return 'nemotron-3-ultra-free';
  if (lower.includes('pickle')) return 'big-pickle';
  
  return 'mimo-v2.5-free';
}

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

    lines.forEach(line => {
      if (!line.startsWith('data: ')) return;
      
      if (line.includes('[DONE]')) {
        res.write('data: [DONE]\n\n');
        return;
      }

      try {
        const data = JSON.parse(line.slice(6));
        // Nếu content null nhưng có reasoning, thay thế
        if (data.choices?.[0]?.delta) {
          const delta = data.choices[0].delta;
          if (!delta.content && delta.reasoning) {
            delta.content = delta.reasoning;
          }
          delete delta.reasoning;
          delete delta.reasoning_details;
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        res.write(`${line}\n`);
      }
    });
  });

  response.data.on('end', () => res.end());
  response.data.on('error', (err) => {
    console.error('Stream error:', err);
    res.end();
  });
}

function handleNonStreamingResponse(response, res, originalModel) {
  const data = response.data;
  
  // Lấy content, xử lý null
  let content = data.choices?.[0]?.message?.content || '';
  
  // Nếu content null nhưng có reasoning, dùng reasoning
  if (!content || content.trim() === '') {
    const reasoning = data.choices?.[0]?.message?.reasoning;
    if (reasoning) {
      content = reasoning;
      console.log(`[Proxy] Used reasoning as content (${content.length} chars)`);
    } else {
      content = "The model did not generate a response. Please try again with a different prompt.";
      console.log(`[Proxy] Used fallback message`);
    }
  }
  
  const transformed = {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || 'mimo-v2.5-free',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content
      },
      finish_reason: data.choices?.[0]?.finish_reason || 'stop'
    }],
    usage: data.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  res.json(transformed);
}

// Catch-all cho 404
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

module.exports = app;