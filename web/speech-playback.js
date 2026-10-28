export function splitSpeech(text) {
 const words=text.replace(/[*#`]/g,'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
 const chunks=[];let chunk='';
 for(const word of words) {
  const limit=chunks.length?240:100;
  if(chunk && chunk.length+word.length+1>limit){chunks.push(chunk);chunk='';}
  chunk+=(chunk?' ':'')+word;
  if(/[.!?]$/.test(word) && chunk.length>45){chunks.push(chunk);chunk='';}
 }
 if(chunk)chunks.push(chunk);return chunks;
}
export function createSpeechPlayer({onLevel=()=>{},onState=()=>{},request}) {
 let context, source, generation=0, frame=0;
 const unlock=async()=>{context??=new (window.AudioContext||window.webkitAudioContext)();await context.resume();};
 function stop() {generation++;cancelAnimationFrame(frame);frame=0;if(source){try{source.stop();}catch{}source=null;}onLevel(0,[0,0,0,0,0]);onState('stopped');}
 async function speak(text) {
  stop();const token=generation;await unlock();if(token!==generation)return;
  const chunks=splitSpeech(text);if(!chunks.length)return;
  const prepare=async chunk=>{const response=await request(chunk);const bytes=await response.arrayBuffer();return context.decodeAudioData(bytes);};
  onState('preparing');let ready=prepare(chunks[0]);
  try {
   for(let i=0;i<chunks.length;i++) {
    const buffer=await ready;if(token!==generation)return;
    // Synthesize the next phrase while the current phrase is playing.
    ready=i+1<chunks.length?prepare(chunks[i+1]):null;
    if(ready)ready.catch(()=>{});
    const node=context.createBufferSource(), analyser=context.createAnalyser();analyser.fftSize=512;analyser.smoothingTimeConstant=.55;
    node.buffer=buffer;node.connect(analyser);analyser.connect(context.destination);source=node;
    const wave=new Float32Array(analyser.fftSize), frequencies=new Uint8Array(analyser.frequencyBinCount);let level=0,last=performance.now();
    function sample(now) {
     if(token!==generation)return;
     analyser.getFloatTimeDomainData(wave);analyser.getByteFrequencyData(frequencies);
     const rms=Math.sqrt(wave.reduce((sum,v)=>sum+v*v,0)/wave.length), target=Math.min(1,rms*6.5),delta=Math.min(.05,(now-last)/1000);last=now;
     level+=(target-level)*(1-Math.exp(-delta/(target > level ? .035 : .10)));
     const bands=[160,350,700,1400,2800].map(hz=>{const bin=Math.round(hz/context.sampleRate*analyser.fftSize),low=Math.max(0,bin-1),high=Math.min(frequencies.length-1,bin+1);let total=0;for(let k=low;k<=high;k++)total+=frequencies[k];return Math.min(1,Math.pow(total/(high-low+1)/255,1.8)*1.2);});
     onLevel(level,bands);frame=requestAnimationFrame(sample);
    }
    onState('speaking');frame=requestAnimationFrame(sample);
    await new Promise(resolve=>{node.onended=resolve;node.start();});
    node.disconnect();analyser.disconnect();
    if(token!==generation)return;
    cancelAnimationFrame(frame);source=null;
   }
  } finally {if(token===generation){onLevel(0,[0,0,0,0,0]);onState('complete');}}
 }
 return {unlock,stop,speak};
}
