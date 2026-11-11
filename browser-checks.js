// Execute this expression in an isolated Studio tab. It uses simulated providers
// and a synthetic microphone; it never sends a generation request or records audio.
(() => {
  window.mediaStudioTest = {state: 'running', checks: []};
  const report = window.mediaStudioTest;
  const originalFetch = window.fetch;
  const OriginalPeer = window.RTCPeerConnection;
  const originalMic = navigator.mediaDevices.getUserMedia;
  const storageBefore = JSON.stringify({...localStorage});
  const $ = id => document.getElementById(id);
  const requests = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=';
  const reply = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
  const assert = (ok, name) => {if (!ok) throw new Error(name); report.checks.push(name);};
  const until = async (fn, limit = 12000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > limit) throw new Error('UI wait timed out: ' + $('runState').textContent + ' / ' + $('notice').textContent);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const choose = title => {
    const button = [...document.querySelectorAll('.modelcard')].find(b => b.querySelector('strong').textContent === title);
    if (!button) throw new Error('Missing model ' + title);
    button.click();
  };
  const run = async () => {
    $('demoForm').requestSubmit();
    await until(() => $('runState').textContent.startsWith('Completed') || $('runState').textContent === 'Demo failed');
    if ($('runState').textContent === 'Demo failed') throw new Error($('notice').textContent);
  };
  window.fetch = async (input, options = {}) => {
    const path = String(input);
    if (!path.startsWith('/v1')) return originalFetch(input, options);
    requests.push({path, body: options.body});
    if (path === '/v1/models') return reply({data: [
      {id: 'gpt-image-2', owned_by: 'openai'}, {id: 'gemini-3.1-flash-image', owned_by: 'antigravity'},
      {id: 'grok-imagine-video', owned_by: 'xai'}, {id: 'grok-tts', owned_by: 'xai'}]});
    if (path === '/v1/realtime') return new Response(JSON.stringify({error:{code:'websocket_upgrade_required'}}),{status:426,headers:{'Content-Type':'application/json'}});
    if (path === '/v1/images/generations' || path === '/v1/images/edits') return reply({data: [{b64_json: png}]});
    if (path.includes(':generateContent')) return reply({candidates: [{content: {parts: [{inlineData: {mimeType: 'image/png', data: png}}]}}]});
    if (path === '/v1/audio/speech') return new Response(new Uint8Array(64), {headers: {'Content-Type': 'audio/mpeg'}});
    if (path === '/v1/videos/generations') return reply({request_id: 'test-video', status: 'queued'});
    if (path === '/v1/videos/test-video') return reply({status: 'done', video: {url: location.origin + '/test.mp4'}});
    if (path === '/v1/realtime/calls') return new Response('v=0\r\n', {status: 201, headers: {Location: '/v1/realtime/calls/test-call'}});
    if (path.endsWith('/hangup')) return reply({status: 'closed'});
    throw new Error('Unexpected test route: ' + path);
  };
  (async () => {
    try {
      $('apiKey').value = 'test-only-placeholder'; $('connectForm').requestSubmit();
      await until(() => $('connectionState').textContent.startsWith('Connected'));
      assert(document.querySelectorAll('.modelcard.listed').length === 4, 'Live discovery merges media models');
      assert([...document.querySelectorAll('.modelcard')].some(b => b.textContent.includes('GPT-Live')), 'Hidden Codex voice remains visible');
      choose('gpt-image-2'); await run(); assert(!!document.querySelector('#output img'), 'Image generation preview');
      $('imageMode').value = 'edit'; $('imageMode').dispatchEvent(new Event('change'));
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'reference.png', {type: 'image/png'}));
      $('imageFile').files = transfer.files; await run();
      assert(requests.some(r => r.path === '/v1/images/edits' && r.body instanceof FormData && r.body.get('image').name === 'reference.png'), 'Image edit sends multipart reference');
      choose('Gemini 3.1 Flash Image'); await run(); assert(!!document.querySelector('#output img'), 'Gemini native image preview');
      choose('grok-tts'); await run(); assert(!!document.querySelector('#output audio'), 'Speech playback controls');
      choose('grok-imagine-video'); await run();
      assert(requests.some(r => r.path === '/v1/videos/test-video') && !!document.querySelector('#output video'), 'Video polling and preview');
      let stopped = 0, closed = 0;
      const track = {enabled: true, stop() {stopped++;}};
      const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
      navigator.mediaDevices.getUserMedia = async () => stream;
      window.RTCPeerConnection = class {
        constructor() {this.connectionState = 'new';this.iceGatheringState='complete';this.localDescription={sdp:'v=0 gathered'};}
        addTrack() {}
        createDataChannel() {this.channel = {readyState: 'open', send() {}, close() {closed++;}}; return this.channel;}
        async createOffer() {return {type: 'offer', sdp: 'v=0'};}
        async setLocalDescription(offer) {this.localDescription=offer;}
        async setRemoteDescription() {
          // Deliver onopen before setRemoteDescription resolves to cover the
          // connection-state ordering race seen during browser verification.
          queueMicrotask(() => {
            this.channel.onopen?.();
            this.channel.onmessage?.({data: JSON.stringify({type: 'response.output_audio_transcript.delta', delta: 'Hello from the test.'})});
          });
        }
        close() {closed++;}
      };
      choose('GPT-Live · Codex'); $('demoForm').requestSubmit();
      await until(() => $('runState').textContent === 'Voice session active');
      assert($('voiceState').textContent.includes('microphone on'), 'Voice connects with synthetic microphone');
      $('mute').click(); assert(!track.enabled, 'Voice mute disables audio track');
      assert($('transcript').textContent.includes('Hello from the test.'), 'Voice transcript renders');
      $('stop').click(); await until(() => stopped > 0 && requests.some(r => r.path.endsWith('/hangup')));
      assert(stopped === 1 && closed >= 2, 'Voice stop releases tracks peer channel and calls hangup');
      $('listedOnly').checked = false; $('listedOnly').dispatchEvent(new Event('change'));
      choose('Sora 2'); assert($('run').disabled && !$('unsupported').hidden, 'Unsupported model cannot run misleading demo');
      $('search').value = 'nonexistent-zz'; $('search').dispatchEvent(new Event('input'));
      assert(document.querySelectorAll('.modelcard').length === 0, 'Search filters catalog');
      $('search').value = ''; $('search').dispatchEvent(new Event('input'));
      $('listedOnly').checked = true; $('listedOnly').dispatchEvent(new Event('change'));
      assert(document.querySelectorAll('.modelcard').length === 6, 'Proxy view keeps both detected voice transports alongside listed models');
      assert(![...document.querySelectorAll('.modelcard')].some(b=>b.textContent.includes('Sora')||b.textContent.includes('Compatibility alias')), 'Proxy view hides reference models and voice aliases');
      assert(JSON.stringify({...localStorage}) === storageBefore, 'No client credential persisted');
      $('disconnect').click(); await until(() => $('connectionState').textContent === 'Disconnected');
      assert($('run').disabled, 'Disconnect disables inference');
      report.state = 'passed';
    } catch (error) {report.state = 'failed'; report.error = error.message;}
    finally {
      $('stop').click();
      window.fetch = originalFetch;
      window.RTCPeerConnection = OriginalPeer;
      navigator.mediaDevices.getUserMedia = originalMic;
    }
  })();
  return {state: 'started'};
})()
