export function baseID(id) {
  return String(id).toLowerCase().split('/').pop().replace(/\([^)]*\)$/, '');
}

export function inferKind(model) {
  const id = baseID(model.id || '');
  const output = (model.supportedOutputModalities || model.supported_output_modalities || model.output_modalities || model.architecture?.output_modalities || []).map(x => x.toLowerCase());
  if (output.some(x => ['embeddings','rerank','decisions','transcription','moderation'].includes(x))) return 'other';
  if (output.includes('video') || /^(sora-|veo[-\d])|grok-imagine-video|text-to-video/.test(id)) return 'video';
  if (output.includes('audio') || output.includes('speech') || /realtime|gpt-live|(?:^|[-_])tts(?:[-_]|$)|transcrib|whisper|speech/.test(id)) return 'voice';
  if (output.includes('image') || /gpt-image|grok-imagine-image|imagen-|flux|stable-diffusion|gemini.*image|dall-e/.test(id)) return 'image';
  if (output.length && !output.includes('text')) return 'other';
  return null;
}

export function adapterFor(id, kind, model = {}) {
  const name = baseID(id);
  if (model.media_gateway) {
    const endpoints = (model.endpoints || []).map(endpoint => endpoint.replace(/^\/v1\//, '/api/v1/'));
    if (endpoints.includes('/api/v1/realtime')) return 'realtime-ws';
    if (endpoints.includes('/api/v1/images')) return 'openrouter-image';
    if (endpoints.includes('/api/v1/images/generations')) return 'image';
    if (endpoints.includes('/api/v1/audio/transcriptions')) return 'transcription';
    if (endpoints.includes('/api/v1/audio/speech')) return 'speech';
    if (kind === 'video' && endpoints.includes('/api/v1/videos')) return 'video';
    const jsonEndpoints = ['/api/v1/embeddings', '/api/v1/rerank', '/api/v1/moderations',
      '/api/alpha/decisions', '/api/alpha/extractions'];
    if (kind === 'other' && endpoints.some(endpoint => jsonEndpoints.includes(endpoint))) return 'json';
    if (endpoints.includes('/api/v1/chat/completions') && ['image', 'voice'].includes(kind)) return 'chat-media';
  }
  if (kind === 'image') {
    if (/^gemini.*image/.test(name)) return 'gemini';
    if (/^imagen-/.test(name)) return 'unsupported';
    return 'image';
  }
  if (kind === 'voice') {
    if (name === 'gpt-live-1-codex') return 'live';
    if (/^gpt-realtime(?:-|$)/.test(name) || /realtime-preview/.test(name)) return 'realtime-ws';
    if (['grok-tts', 'grok-voice-tts-1.0'].includes(name)) return 'speech';
    return 'unsupported';
  }
  if (kind === 'video' && /^grok-imagine-video(?:-1\.5(?:-preview)?)?$/.test(name)) return 'video';
  return 'unsupported';
}

export function mergeCatalog(catalog, liveModels, {voiceRouteDetected = false} = {}) {
  const merged = new Map(catalog.map(m => [m.id, {...m, adapter: m.adapter || adapterFor(m.id, m.kind), listed: false,
    routeDetected: ['gpt-live-1-codex','gpt-realtime'].includes(m.id) && voiceRouteDetected, source: 'Built-in catalog'}]));
  for (const m of liveModels) {
    const known = merged.get(m.id) || catalog.find(x => x.id === baseID(m.id));
    const kind = known?.kind || inferKind(m);
    if (!kind) continue;
    merged.set(m.id, {...known, id: m.id, title: m.display_name || known?.title || m.id,
      provider: m.owned_by || known?.provider || 'Proxy', kind,
      adapter: m.media_gateway ? adapterFor(m.id, kind, m) : known?.adapter || adapterFor(m.id, kind),
      endpoints: m.endpoints?.map(endpoint => endpoint.replace(/^\/v1\//, '/api/v1/')), voices: m.supported_voices,
      architecture: {...m.architecture, output_modalities: m.architecture?.output_modalities ||
        m.supportedOutputModalities || m.supported_output_modalities || m.output_modalities || []},
      listed: true, source: '/v1/models',
      note: known?.note || 'Discovered from the proxy. A listed model still needs a successful demo to confirm access.'});
  }
  return [...merged.values()].sort((a,b) => Number(b.listed) - Number(a.listed) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function sampleRequest(model) {
  const endpoints = model.endpoints || [];
  if (endpoints.includes('/api/v1/embeddings')) return {input: 'A quiet mountain lake at sunrise.'};
  if (endpoints.includes('/api/v1/rerank')) {
    return {query: 'Which place has water?', documents: ['A mountain lake.', 'A dry desert.'], top_n: 2};
  }
  if (endpoints.includes('/api/v1/moderations')) return {input: 'A friendly greeting.'};
  return {state: 'The assistant politely answered the question.',
    questions: {polite: {type: 'noul', instructions: 'Is the assistant polite?'}}};
}

export function speechFormat(model) {
  // HeyGen speech returns 16-bit, 44.1 kHz mono PCM.
  return model.id.startsWith('openrouter/heygen/') ? {format: 'pcm', rate: 44100} : {format: 'mp3'};
}

export function statusFor(m, connected) {
  if (m.adapter === 'unsupported') return 'Needs adapter';
  if (m.id === 'gpt-live-1-codex') return m.routeDetected ? 'Voice route · access unverified' : connected ? 'Voice route not detected' : 'Connect to check voice route';
  if (m.adapter === 'realtime-ws' && m.routeDetected) return 'WebSocket voice route';
  if (m.alias) return 'Compatibility alias';
  return m.listed ? 'Listed by proxy' : connected ? 'Not listed' : 'Connect to check';
}

export function visibleInProxyView(model) {
  return model.listed || (['gpt-live-1-codex','gpt-realtime'].includes(model.id) && model.routeDetected === true);
}

export async function gatherICE(peer,signal,timeoutMs=10000) {
  if(peer.iceGatheringState==='complete')return peer.localDescription.sdp;
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',check);signal?.removeEventListener('abort',abort);};
    const check=()=>{if(peer.iceGatheringState==='complete'){cleanup();resolve(peer.localDescription.sdp);}};
    const abort=()=>{cleanup();reject(new DOMException('Stopped','AbortError'));};
    const timer=setTimeout(()=>{cleanup();reject(new Error('Could not gather WebRTC network candidates. Try gpt-realtime WebSocket voice instead.'));},timeoutMs);
    peer.addEventListener('icegatheringstatechange',check);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();else check();
  });
}

export function safeMediaURL(value, origin) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, origin);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || url.protocol === 'blob:' || (url.origin === origin && url.protocol === 'http:')) return url.href;
  } catch {}
  return null;
}

export function videoState(job) {
  const status = String(job.status || '').toLowerCase();
  if (job.error || ['failed','error','cancelled','canceled','expired'].includes(status)) return 'failed';
  if (['completed','done','succeeded','success'].includes(status)) return 'completed';
  return 'pending';
}

export function summarize(value) {
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'string' && (['b64_json','data','result'].includes(key) && item.length > 500)) return `[${item.length} characters omitted]`;
    return item;
  }, 2).slice(0, 24000);
}

export function imagePayload(model, prompt, size, quality) {
  const body = {model, prompt, n: 1, response_format: 'b64_json'};
  if (size !== 'auto') body.size = size;
  if (quality !== 'auto') body.quality = quality;
  return body;
}
