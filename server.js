// server.js - OpenAI to OpenCode Zen Proxy (FREE Models Only)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Cấu hình
const ZEN_API_KEY = process.env.ZEN_API_KEY;
const ZEN_API_BASE = 'https://opencode.ai/zen/v1';

// Chỉ giữ các model FREE - Tên đầy đủ
const FREE_MODELS = {
  'big-pickle': 'opencode/big-pickle',
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
    service: 'OpenCode FREE Proxy',
    free_models: Object.keys(FREE_MODELS)
  });
});

// List models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(FREE_MODELS).map(id => ({
      id: id,
      object: 'model',
      owned_by: 'opencode-free'
    }))
  });
});

// Chat completions
app.post('/v1/chat/completions', async (req, res) => {
  if (!ZEN_API_KEY) {
    return res.status(500).json({ error: { message: 'Missing ZEN_API_KEY' } });
  }

  try {
    const { model, messages, temperature = 0.7, max_tokens = 4096, stream = false } = req.body;
    
    // Kiểm tra model có trong danh sách free không
    let zenModel = FREE_MODELS[model];
    if (!zenModel) {
      return res.status(400).json({ 
        error: { 
          message: `Model "${model}" không có trong danh sách free. Các model hỗ trợ: ${Object.keys(FREE_MODELS).join(', ')}` 
        } 
      });
    }

    const response = await axios.post(
      `${ZEN_API_BASE}/chat/completions`,
      { model: zenModel, messages, temperature, max_tokens, stream },
      {
        headers: {
          'Authorization': `Bearer ${ZEN_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000,
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }

  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: { message: error.response?.data?.error?.message || error.message }
    });
  }
});

module.exports = app;