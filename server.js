// server.js - OpenAI to NVIDIA NIM Proxy (Fix 404)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============= CONFIGURATION =============
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ============= MODEL MAPPING =============
const MODEL_MAPPING = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'minimax-m3': 'minimaxai/minimax-m3'
};

// ============= MIDDLEWARE =============
app.use(cors());
app.use(express.json());

// ============= LOGGING =============
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============= ROUTES =============

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy'
  });
});

// List models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions (chính)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('Request body:', JSON.stringify(req.body).substring(0, 200));
    
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    if (!model) {
      return res.status(400).json({
        error: { message: 'Model is required', type: 'invalid_request_error', code: 400 }
      });
    }
    
    // Get model mapping
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      // Fallback nếu model không có trong mapping
      nimModel = 'deepseek-ai/deepseek-v4-flash';
    }
    
    // Build NIM request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 4096,
      stream: stream || false
    };
    
    console.log(`Using NIM model: ${nimModel}`);
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 60000
    });
    
    if (stream) {
      // Xử lý streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      response.data.pipe(res);
      
      response.data.on('end', () => {
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform NIM response to OpenAI format
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => ({
          index: choice.index,
          message: {
            role: choice.message.role,
            content: choice.message.content
          },
          finish_reason: choice.finish_reason
        })),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error?.message || error.message || 'Internal server error';
    
    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type: 'invalid_request_error',
        code: statusCode
      }
    });
  }
});

// ============= FIX: Support /v1/chat/completions với trailing slash =============
app.post('/v1/chat/completions/', async (req, res) => {
  // Forward to main endpoint
  req.url = '/v1/chat/completions';
  app._router.handle(req, res);
});

// ============= FIX: Support OpenAI compatible endpoints =============
app.post('/chat/completions', async (req, res) => {
  req.url = '/v1/chat/completions';
  app._router.handle(req, res);
});

app.post('/chat/completions/', async (req, res) => {
  req.url = '/v1/chat/completions';
  app._router.handle(req, res);
});

// ============= FIX: Support /v1 endpoint =============
app.post('/v1', async (req, res) => {
  req.url = '/v1/chat/completions';
  app._router.handle(req, res);
});

// ============= DEBUG: Log all requests =============
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.includes('chat')) {
    console.log('POST to:', req.path);
    console.log('Headers:', req.headers);
  }
  next();
});

// ============= START SERVER =============
app.listen(PORT, () => {
  console.log(`🚀 OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Available models: ${Object.keys(MODEL_MAPPING).join(', ')}`);
  console.log(`🔗 Chat endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`✅ Try: curl http://localhost:${PORT}/health`);
});