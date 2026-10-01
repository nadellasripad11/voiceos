const fs=require('fs'),path=require('path'),{execFile}=require('child_process');
const {WhisperEngine}=require('../src/core/stt/whisper');
const {paths,ensureDirs}=require('../src/core/paths');
const S='Remind me to send Maya the deck tomorrow morning.';
const P='Vocabulary: Maya, Sripad, Hackatime, VoiceOS, Rojo.';
function syn(t,o){const s=`
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile(${JSON.stringify(o)},$f);$s.Speak(${JSON.stringify(t)});$s.Dispose()`;
return new Promise((r,j)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',s],(e,_,se)=>e?j(new Error(se||e.message)):r(o)));}
const n=s=>s.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
const ac=(e,a)=>{const E=n(e).split(' '),A=new Set(n(a).split(' '));return E.filter(w=>A.has(w)).length/E.length};
const med=x=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)];
const COMBOS=[
 {model:'ggml-tiny.en.bin',greedy:true},
 {model:'ggml-tiny.en-q5_1.bin',greedy:true},
 {model:'ggml-tiny.en-q5_1.bin',greedy:true,ac:768},
 {model:'ggml-base.en-q5_1.bin',greedy:true},
 {model:'ggml-base.en-q5_1.bin',greedy:true,ac:768},
 {model:'ggml-base.en.bin',greedy:true},
 {model:'ggml-base.en.bin',greedy:false},
 {model:'ggml-small.en-q5_1.bin',greedy:true,ac:768},
];
(async()=>{ensureDirs();const w=path.join(paths.tmp,'s2.wav');await syn(S,w);const sec=3.4;
console.log('\nmodel                     decode   ac    median    rtf  acc');
console.log('-'.repeat(62));
const res=[];
for(const c of COMBOS){
 if(!fs.existsSync(path.join(paths.models,c.model))){console.log(c.model+' missing');continue;}
 const e=new WhisperEngine({model:c.model,language:'en',threads:7,
   beamSize:c.greedy?1:5,bestOf:c.greedy?1:5,noFallback:c.greedy,audioCtx:c.ac||0});
 const ts=[];let txt='';
 for(let i=0;i<3;i++){const r=await e.transcribe(w,{language:'en',prompt:P});ts.push(r.ms);txt=r.text;}
 const m=med(ts),a=ac(S,txt);res.push({...c,m,a,txt});
 console.log(`${c.model.replace('ggml-','').replace('.bin','').padEnd(24)} ${(c.greedy?'greedy':'beam5').padEnd(7)} ${String(c.ac||'-').padEnd(5)} ${String(m).padStart(6)}ms ${(m/(sec*1000)).toFixed(2)}  ${(a*100).toFixed(0)}%`);
}
console.log('-'.repeat(62));
const ok=res.filter(r=>r.a>=0.9).sort((a,b)=>a.m-b.m);
if(ok[0]){const b=ok[0];console.log(`\nBEST at >=90%: ${b.model} ${b.greedy?'greedy':'beam5'} ac=${b.ac||'full'}`);
console.log(`  ${b.m}ms for ${sec}s  (RTF ${(b.m/(sec*1000)).toFixed(2)})`);console.log(`  "${b.txt}"`);
const base=res.find(r=>r.model==='ggml-base.en.bin'&&!r.greedy);
if(base)console.log(`  vs stock base.en+beam5 (${base.m}ms): ${(base.m/b.m).toFixed(1)}x faster`);}
fs.rmSync(w,{force:true});})().catch(e=>{console.error('FATAL',e.message);process.exit(1)});
