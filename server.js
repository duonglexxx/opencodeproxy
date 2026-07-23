// server.js - OpenAI to OpenCode Zen Proxy (FREE Models)
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
  // Tên rút gọn -> Model ID đầy đủ cho OpenCode Zen
  'big-pickle': 'opencode/big-pickle',
  'deepseek-free': 'opencode/deepseek-v4-flash-free',
  'mimo-free': 'opencode/mimo-v2.5-free',
  'laguna-free': 'opencode/laguna-s-2.1-free',
  'north-free': 'opencode/north-mini-code-free',
  'nemotron-free': 'opencode/nemotron-3-ultra-free',
  
  // Hỗ trợ tên đầy đủ
  'deepseek-v4-flash-free': 'opencode/deepseek-v4-flash-free',
  'mimo-v2.5-free': 'opencode/mimo-v2.5-free',
  'laguna-s-2.1-free': 'opencode/laguna-s-2.1-free',
  'north-mini-code-free': 'opencode/north-mini-code-free',
  'nemotron-3-ultra-free': 'opencode/nemotron-3-ultra-free'
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to OpenCode Zen Proxy',
    version: '1.0.0',
    available_models: Object.keys(MODEL_MAPPING),
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

    // Validate API key
    if (!ZEN_API_KEY) {
      throw new Error('ZEN_API_KEY is not configured');
    }

    // Smart model selection
    let zenModel = getModelMapping(model);

    // Transform request
    const zenRequest = {
      model: zenModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: Math.min(max_tokens || 4096, 16384),
      stream: stream || false
    };

    console.log(`[Proxy] Using model: ${zenModel} for request: ${model || 'default'}`);

    // Make request to OpenCode Zen
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

    // Handle streaming
    if (stream) {
      return handleStreamingResponse(response, res);
    }

    // Handle non-streaming
    return handleNonStreamingResponse(response, res, model);

  } catch (error) {
    console.error('Proxy error:', error.message);
    
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

// Helper functions
function getModelMapping(model) {
  if (!model) {
    // Default model nếu không có model được chỉ định
    return 'opencode/mimo-v2.5-free';
  }
  
  // Kiểm tra trong MODEL_MAPPING
  const mapped = MODEL_MAPPING[model];
  if (mapped) return mapped;

  // Smart fallback
  const lower = model.toLowerCase();
  
  // Map các tên model phổ biến sang model free
  if (lower.includes('deepseek') || lower.includes('v4') || lower.includes('flash')) {
    return 'opencode/deepseek-v4-flash-free';
  } else if (lower.includes('mimo') || lower.includes('v2.5')) {
    return 'opencode/mimo-v2.5-free';
  } else if (lower.includes('laguna')) {
    return 'opencode/laguna-s-2.1-free';
  } else if (lower.includes('north') || lower.includes('mini')) {
    return 'opencode/north-mini-code-free';
  } else if (lower.includes('nemotron')) {
    return 'opencode/nemotron-3-ultra-free';
  } else if (lower.includes('pickle')) {
    return 'opencode/big-pickle';
  }
  
  // Fallback cuối cùng
  return 'opencode/mimo-v2.5-free';
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
        if (data.choices?.[0]?.delta) {
          const delta = data.choices[0].delta;
          
          // Chỉ giữ lại content
          if (delta.content) {
            delta.content = delta.content;
          } else {
            delta.content = '';
          }
          delete delta.reasoning_content;
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
  
  const transformed = {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: data.choices?.map(choice => {
      const content = choice.message?.content || '';
      
      return {
        index: choice.index || 0,
        message: {
          role: choice.message?.role || 'assistant',
          content: content
        },
        finish_reason: choice.finish_reason || 'stop'
      };
    }) || [],
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

// Export cho Vercel
module.exports = app;