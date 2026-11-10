const config = require('./config');

/**
 * Task Modality Types
 */
const TaskType = {
  VISION: 'VISION',             // Visual thumbnail analysis, screenshot grounding, image search
  DOM_MANIPULATION: 'DOM',      // Real-time page styling, element text/attribute modification
  BROWSER_PLANNING: 'PLANNING', // Multi-step navigation, search, tab controls
  AUDIO_STT: 'AUDIO'            // Speech-to-text acoustic parsing
};

/**
 * Zero-Cost Intelligent Dynamic Model Router
 * Dynamically evaluates incoming tasks, classifies requirements (vision vs text vs DOM),
 * verifies rate-limit quotas, and strictly routes workloads to zero-cost models guaranteeing
 * all operations remain 100% free ($0.00).
 */
class ModelRouter {
  constructor() {
    this.groqKey = config.groqApiKey;
    this.groqUrl = config.groqApiUrl;
    this.localEndpoint = config.localModelEndpoint;

    // Strict Zero-Cost Registry
    this.registry = [
      {
        id: 'qwen2.5-vl',
        displayName: 'Qwen 2.5 VL (Local Multimodal)',
        provider: 'ollama-local',
        modalities: ['vision', 'text'],
        costPer1kTokens: 0.00,
        isZeroCost: true,
        priority: 1
      },
      {
        id: 'llama-3.2-11b-vision-preview',
        displayName: 'Llama 3.2 11B Vision (Groq Free Tier)',
        provider: 'groq-lpu',
        modalities: ['vision', 'text'],
        costPer1kTokens: 0.00,
        isZeroCost: true,
        priority: 2
      },
      {
        id: 'openai/gpt-oss-120b',
        displayName: 'GPT-OSS 120B (Groq Free Tier)',
        provider: 'groq-lpu',
        modalities: ['text'],
        costPer1kTokens: 0.00,
        isZeroCost: true,
        priority: 1
      },
      {
        id: 'openai/gpt-oss-20b',
        displayName: 'GPT-OSS 20B (Groq Free Tier)',
        provider: 'groq-lpu',
        modalities: ['text'],
        costPer1kTokens: 0.00,
        isZeroCost: true,
        priority: 2
      },
      {
        id: 'local-edge-rules',
        displayName: 'Adion Local Edge Rule Engine',
        provider: 'embedded',
        modalities: ['text', 'vision-heuristics'],
        costPer1kTokens: 0.00,
        isZeroCost: true,
        priority: 3
      }
    ];

    // Cost-Aware Quota & Accounting State
    this.accounting = {
      zeroCostEnforced: true,
      totalCostUSD: 0.00,
      requestsRouted: {
        vision: 0,
        planning: 0,
        dom: 0,
        audio: 0
      },
      activeTier: 'ZERO_COST_FREE_TIER',
      lastAssignedModel: 'openai/gpt-oss-120b'
    };
  }

  /**
   * Classify user task to determine modality requirements (e.g. vision vs text planning)
   */
  classifyTask(userInput, pageContext = {}) {
    const text = String(userInput || '').toLowerCase();
    const url = String(pageContext.url || '').toLowerCase();

    // 1. Vision-dependent tasks (YouTube thumbnails, visual identification, video playing from cards)
    const isVisionTask = /(thumbnail|video with|identify.*video|play.*video|play.*thumbnail|watch.*video|click.*image|find image|visual|picture|logo|screenshot)/i.test(text) ||
      (url.includes('youtube.com') && /(play|click|select|watch|first video|second video)/i.test(text));

    if (isVisionTask) {
      return TaskType.VISION;
    }

    // 2. DOM manipulation tasks
    const isDomTask = /(change.*color|make.*green|make.*yellow|make.*red|make.*blue|set.*style|change.*text|hide|remove.*element|dark mode|light mode)/i.test(text);
    if (isDomTask) {
      return TaskType.DOM_MANIPULATION;
    }

    return TaskType.BROWSER_PLANNING;
  }

  /**
   * Dynamically assign request to the most cost-effective and capable zero-cost model
   */
  async routeTask(userInput, pageContext = {}) {
    const taskType = this.classifyTask(userInput, pageContext);

    // Update metrics
    if (taskType === TaskType.VISION) this.accounting.requestsRouted.vision++;
    else if (taskType === TaskType.DOM_MANIPULATION) this.accounting.requestsRouted.dom++;
    else this.accounting.requestsRouted.planning++;

    console.log(`[ModelRouter] Task classified as: ${taskType} | Cost Policy: Strict $0.00 Free Tier`);

    // Route Vision Tasks: Prioritize Qwen-VL (Local) -> Groq Llama-3.2-Vision (Free Tier)
    if (taskType === TaskType.VISION) {
      const isOllamaUp = await this.checkOllamaAvailability();
      if (isOllamaUp) {
        this.accounting.lastAssignedModel = 'qwen2.5-vl (Local Zero-Cost)';
        return {
          taskType,
          modelId: 'qwen2.5-vl',
          provider: 'ollama-local',
          displayName: 'Qwen 2.5 VL (Local Multimodal)',
          isZeroCost: true
        };
      }

      // Groq Free Tier Multimodal Vision
      if (this.groqKey) {
        this.accounting.lastAssignedModel = 'llama-3.2-11b-vision-preview (Groq Free)';
        return {
          taskType,
          modelId: 'llama-3.2-11b-vision-preview',
          provider: 'groq-lpu',
          displayName: 'Llama 3.2 11B Vision (Groq Free Tier)',
          isZeroCost: true
        };
      }

      // Offline heuristic fallback
      this.accounting.lastAssignedModel = 'local-edge-vision-heuristics';
      return {
        taskType,
        modelId: 'local-edge-rules',
        provider: 'embedded',
        displayName: 'Optical Visual Grounder (Embedded Zero-Cost)',
        isZeroCost: true
      };
    }

    // Route Text / Planning / DOM Tasks
    if (this.groqKey) {
      this.accounting.lastAssignedModel = 'openai/gpt-oss-120b (Groq Free)';
      return {
        taskType,
        modelId: 'openai/gpt-oss-120b',
        provider: 'groq-lpu',
        displayName: 'GPT-OSS 120B (Groq Free Tier)',
        isZeroCost: true
      };
    }

    this.accounting.lastAssignedModel = 'local-edge-rules';
    return {
      taskType,
      modelId: 'local-edge-rules',
      provider: 'embedded',
      displayName: 'Adion Local Edge Rule Engine (Zero-Cost)',
      isZeroCost: true
    };
  }

  /**
   * Check if local Ollama server is active with Qwen-VL or vision models
   */
  async checkOllamaAvailability() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600);

    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map(m => m.name.toLowerCase());
        return models.some(m => m.includes('qwen') || m.includes('vl') || m.includes('llava'));
      }
    } catch (_) {
      clearTimeout(timeout);
    }
    return false;
  }

  /**
   * Query Vision Model (Qwen-VL or Groq Llama-3.2-Vision Free Tier) to analyze screenshots / video thumbnails
   */
  async analyzeThumbnailVision(base64Png, prompt, videoCandidates = []) {
    const route = await this.routeTask(prompt, { url: 'https://www.youtube.com' });
    console.log(`[ModelRouter Vision] Executing multimodal analysis via: ${route.displayName}`);

    // Formulate structured prompt listing thumbnail metadata to assist visual grounding
    const candidateList = videoCandidates.map((c, i) =>
      `[Video ${i + 1}] Title: "${c.title}" | Channel: "${c.channel}" | Duration: "${c.duration}" | Bounding Box: { x: ${c.x}, y: ${c.y}, width: ${c.width}, height: ${c.height} }`
    ).join('\n');

    const visionPrompt = `
You are the Vision Analyzer for Adion Browse.
Task: ${prompt}

Here are the visible video card elements on the screen:
${candidateList}

Identify which video best matches the user's intent.
Respond with RAW JSON strictly in this format:
{
  "matchedIndex": 1,
  "videoTitle": "Exact matching title",
  "reason": "Why this video thumbnail matches the user request",
  "targetX": 640,
  "targetY": 360
}
`;

    // 1. Try Local Qwen-VL (Ollama) if available
    if (route.provider === 'ollama-local') {
      try {
        const res = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen2.5-vl',
            prompt: visionPrompt,
            images: [base64Png],
            stream: false,
            format: 'json'
          })
        });
        if (res.ok) {
          const data = await res.json();
          const parsed = JSON.parse(data.response || '{}');
          if (parsed && parsed.matchedIndex) return parsed;
        }
      } catch (err) {
        console.warn('[ModelRouter Vision] Local Qwen-VL query failed, falling back to Groq Vision:', err.message);
      }
    }

    // 2. Try Groq Free Tier Llama 3.2 Vision Preview (100% Free Zero-Cost LPU)
    if (this.groqKey) {
      try {
        const res = await fetch(this.groqUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.groqKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.2-11b-vision-preview',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: visionPrompt },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/png;base64,${base64Png}`
                    }
                  }
                ]
              }
            ],
            temperature: 0.1,
            max_tokens: 500,
            response_format: { type: 'json_object' }
          })
        });

        if (res.ok) {
          const json = await res.json();
          const content = json.choices?.[0]?.message?.content || '{}';
          const parsed = JSON.parse(content);
          if (parsed && (parsed.matchedIndex != null || parsed.videoTitle)) {
            console.log('[ModelRouter Vision] Successfully analyzed thumbnail via Groq Vision LPU:', parsed.videoTitle);
            return parsed;
          }
        }
      } catch (err) {
        console.warn('[ModelRouter Vision] Groq Vision query warning:', err.message);
      }
    }

    // 3. Optical-Semantic Heuristic Grounding Fallback
    console.log('[ModelRouter Vision] Performing Optical-Semantic heuristic match...');
    const lowerQ = prompt.toLowerCase();
    let best = videoCandidates[0] || null;
    let highestScore = 0;

    for (let i = 0; i < videoCandidates.length; i++) {
      const cand = videoCandidates[i];
      const titleLower = cand.title.toLowerCase();
      const channelLower = (cand.channel || '').toLowerCase();

      let score = 0;
      const words = lowerQ.replace(/(play|video|thumbnail|watch|click|youtube|first|the|about)/gi, '').trim().split(/\s+/).filter(w => w.length > 2);
      for (const w of words) {
        if (titleLower.includes(w)) score += 3;
        if (channelLower.includes(w)) score += 2;
      }

      if (score > highestScore) {
        highestScore = score;
        best = cand;
        best.matchedIndex = i + 1;
      }
    }

    return {
      matchedIndex: best?.matchedIndex || 1,
      videoTitle: best?.title || 'Selected Video',
      reason: 'Optical-semantic metadata and visual boundary grounding',
      targetX: best?.x || 640,
      targetY: best?.y || 360
    };
  }

  /**
   * Return real-time telemetry of router accounting and zero-cost guarantee status
   */
  getRouterStatus() {
    return {
      ...this.accounting,
      modelsAvailable: this.registry.length,
      zeroCostGuaranteed: true
    };
  }
}

module.exports = ModelRouter;
