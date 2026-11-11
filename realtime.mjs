export function encodePCM16(samples, inputRate = 24000, outputRate = 24000) {
  const length = Math.floor(samples.length * outputRate / inputRate);
  const bytes = new Uint8Array(length * 2), view = new DataView(bytes.buffer);
  for (let i=0;i<length;i++) {
    const position=i*inputRate/outputRate, left=Math.floor(position), fraction=position-left;
    const sample=Math.max(-1,Math.min(1,(samples[left] || 0)*(1-fraction)+(samples[Math.min(left+1,samples.length-1)] || 0)*fraction));
    view.setInt16(i*2,Math.round(sample*(sample<0?32768:32767)),true);
  }
  return bytes;
}

export function decodePCM16(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), samples=new Float32Array(Math.floor(bytes.length/2));
  for(let i=0;i<samples.length;i++) samples[i]=view.getInt16(i*2,true)/32768;
  return samples;
}

export function pcmWav(chunks, rate=24000) {
  const size=chunks.reduce((n,c)=>n+c.length,0), result=new Uint8Array(44+size), view=new DataView(result.buffer);
  const text=(offset,value)=>{for(let i=0;i<value.length;i++)result[offset+i]=value.charCodeAt(i);};
  text(0,'RIFF');view.setUint32(4,size+36,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,size,true);
  let offset=44;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}

function toBase64(bytes) {
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
}

export class RealtimeVoice {
  constructor(callbacks={}) {this.callbacks=callbacks;this.sources=new Set();this.chunks=[];this.bytes=0;this.ready=false;this.closed=false;this.muted=false;}
  async start({key,model,instructions,voice,signal}) {
    const Audio=window.AudioContext || window.webkitAudioContext;
    if(!Audio)throw new Error('This browser does not support Web Audio playback.');
    this.context=new Audio({sampleRate:24000});await this.context.resume();
    this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    if(signal?.aborted || this.closed){await this.stop();throw new DOMException('Stopped','AbortError');}
    this.abort=()=>this.stop();signal?.addEventListener('abort',this.abort,{once:true});this.signal=signal;
    this.input=this.context.createMediaStreamSource(this.stream);
    this.processor=this.context.createScriptProcessor(2048,1,1);
    this.silent=this.context.createGain();this.silent.gain.value=0;
    this.input.connect(this.processor);this.processor.connect(this.silent);this.silent.connect(this.context.destination);
    this.processor.onaudioprocess=event=>{
      if(!this.ready || this.muted || this.socket?.readyState!==WebSocket.OPEN)return;
      if(this.socket.bufferedAmount>512*1024)return;
      const bytes=encodePCM16(event.inputBuffer.getChannelData(0),this.context.sampleRate);
      this.socket.send(JSON.stringify({type:'input_audio_buffer.append',audio:toBase64(bytes)}));
    };
    const endpoint=new URL('/v1/realtime',location.origin);endpoint.protocol=location.protocol==='https:'?'wss:':'ws:';
    endpoint.searchParams.set('model',model);
    // Native browser WebSockets cannot set Authorization headers. The host's
    // existing same-origin auth_token mechanism is masked by its query logger.
    // This is a socket URL only: it is never navigated, persisted or displayed.
    endpoint.searchParams.set('auth_token',key);
    this.socket=new WebSocket(endpoint);
    this.timer=setTimeout(()=>this.fail(new Error('The voice session did not become ready within 20 seconds. Check account access or proxy connectivity.')),20000);
    this.socket.onmessage=event=>{
      if(this.closed)return;
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(data.type==='error'){this.fail(new Error(data.error?.message || 'Realtime voice reported an error.'));return;}
      if(data.type==='session.created'){
        this.actualModel=data.session?.model || model;
        this.socket.send(JSON.stringify({type:'session.update',session:{type:'realtime',instructions,
          audio:{input:{format:{type:'audio/pcm',rate:24000},turn_detection:{type:'server_vad',create_response:true,interrupt_response:true}},
            output:{format:{type:'audio/pcm',rate:24000},voice}}}}));
      }
      if(data.type==='session.updated' && !this.ready){
        clearTimeout(this.timer);this.ready=true;this.callbacks.onReady?.(this.actualModel);
        this.socket.send(JSON.stringify({type:'response.create',response:{output_modalities:['audio'],instructions:'Greet the user briefly and ask what they would like to talk about.'}}));
      }
      if(data.type==='input_audio_buffer.speech_started')this.interrupt();
      if(data.type==='response.created'){this.chunks=[];this.bytes=0;}
      if(data.type==='response.output_audio.delta' || data.type==='response.audio.delta'){
        const bytes=Uint8Array.from(atob(data.delta || ''),c=>c.charCodeAt(0));this.play(bytes);
        if(this.bytes+bytes.length<10*1024*1024){this.chunks.push(bytes);this.bytes+=bytes.length;}
        this.callbacks.onAudio?.(bytes.length);return;
      }
      if(data.type==='response.done' && this.chunks.length){this.callbacks.onRecording?.(pcmWav(this.chunks));this.chunks=[];this.bytes=0;}
      this.callbacks.onEvent?.(data);
    };
    this.socket.onerror=()=>this.fail(new Error('The Realtime WebSocket could not connect. Check your proxy client key and account access.'));
    this.socket.onclose=()=>{if(!this.closed)this.fail(new Error('The voice connection closed. Microphone released.'));};
  }
  play(bytes) {
    if(this.closed || !this.context || !bytes.length)return;
    const samples=decodePCM16(bytes), buffer=this.context.createBuffer(1,samples.length,24000);buffer.copyToChannel(samples,0);
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);
    const when=Math.max(this.context.currentTime+0.025,this.nextPlayback || 0);this.nextPlayback=when+buffer.duration;
    this.sources.add(source);source.onended=()=>{this.sources.delete(source);source.disconnect();};source.start(when);
  }
  interrupt() {for(const source of this.sources){try{source.stop();}catch{}}this.sources.clear();this.nextPlayback=0;}
  mute(value) {this.muted=value;this.stream?.getAudioTracks().forEach(track=>track.enabled=!value);return this.muted;}
  fail(error) {if(this.closed)return;this.callbacks.onError?.(error);this.stop();}
  async stop() {
    this.closed=true;this.ready=false;clearTimeout(this.timer);this.signal?.removeEventListener('abort',this.abort);
    this.interrupt();if(this.processor){this.processor.onaudioprocess=null;this.processor.disconnect();}
    this.input?.disconnect();this.silent?.disconnect();this.stream?.getTracks().forEach(track=>track.stop());
    if(this.socket){this.socket.onclose=null;this.socket.onerror=null;this.socket.onmessage=null;this.socket.close();}
    await this.context?.close().catch(()=>{});
  }
}
