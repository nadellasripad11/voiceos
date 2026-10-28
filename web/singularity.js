/* Jarvis's singularity combines animated geometry with shaded orbital sprites. */
import { createCoreField } from './core-field.js';
import { sceneLayout } from './scene-layout.js';
const TAU = Math.PI * 2;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const mix = (a, b, t) => a + (b - a) * t;
const gaussian = n => Math.exp(-(n*n));
const DISK_TILT = Math.PI / 15;
const BRIGHT_ANGLE = -2.35;

function randomSource(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function sampleCurve(points, t) {
  const position = t * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(position));
  const u = position - i;
  const p0 = points[Math.max(0, i - 1)], p1 = points[i];
  const p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
  const u2 = u * u, u3 = u2 * u;
  const component = axis => .5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * u +
    (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * u2 +
    (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * u3);
  return [component(0), component(1)];
}

// Refract the actual rendered strands, rather than drawing another wire ring.
function createRefractionPass() {
  const source=document.createElement('canvas'),output=document.createElement('canvas');
  source.width=source.height=output.width=output.height=384;
  const capture=source.getContext('2d'),gl=output.getContext('webgl',{alpha:true,premultipliedAlpha:false,depth:false});
  const shaders=[];let program,buffer,texture,timeUniform;
  const dispose=()=>{if(!gl)return;shaders.forEach(s=>gl.deleteShader(s));if(program)gl.deleteProgram(program);if(buffer)gl.deleteBuffer(buffer);if(texture)gl.deleteTexture(texture);};
  let ready=false;
  if(gl)try {
    const compile=(type,text)=>{const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,text);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('Refraction unavailable');return shader;};
    program=gl.createProgram();
    gl.attachShader(program,compile(gl.VERTEX_SHADER,'attribute vec2 p; varying vec2 uv; void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`precision mediump float; varying vec2 uv; uniform sampler2D image; uniform float time;
      void main(){vec2 w=(vec2(uv.x,1.-uv.y)-.5)*440.;float r=length(w),a=atan(w.y,w.x);
      float mask=smoothstep(118.,124.,r)*(1.-smoothstep(151.,165.,r));
      float sr=174.+(r-126.)*1.75;
      float sa=a+.09*sin(a*3.+time*.22)*exp(-pow((r-135.)/21.,2.));
      vec2 sampleUv=vec2(.5+cos(sa)*sr/440.,.5-sin(sa)*sr/440.);
      vec4 light=texture2D(image,sampleUv);
      gl_FragColor=vec4(light.rgb,light.a*mask*.48);}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Refraction unavailable');
    gl.useProgram(program);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    for(const parameter of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,parameter,gl.LINEAR);
    for(const parameter of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,parameter,gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.uniform1i(gl.getUniformLocation(program,'image'),0);
    timeUniform=gl.getUniformLocation(program,'time');gl.viewport(0,0,384,384);ready=true;
  }catch{dispose();}
  return {
    draw(ctx,scene,cx,cy,scale,dpr,time){
      if(!capture)return;
      capture.clearRect(0,0,384,384);
      capture.drawImage(scene,(cx-220*scale)*dpr,(cy-220*scale)*dpr,440*scale*dpr,440*scale*dpr,0,0,384,384);
      if(ready){gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);gl.uniform1f(timeUniform,time);gl.drawArrays(gl.TRIANGLES,0,6);ctx.drawImage(output,-220,-220,440,440);}
      else {ctx.save();ctx.beginPath();ctx.arc(0,0,157,0,TAU);ctx.arc(0,0,122,0,TAU,true);ctx.clip('evenodd');ctx.globalAlpha=.24;ctx.rotate(.025*Math.sin(time*.22));ctx.drawImage(source,-185,-185,370,370);ctx.restore();}
    },
    destroy(){if(ready)dispose();source.width=output.width=0;},
  };
}

export function createSingularity(canvas, { getEnergy = () => 0, getSpeechLevel = () => 0, getProgress = () => 1, getMotion = () => true, getInteraction = () => true, getState = () => 'idle', onLight = () => {} } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { cue() {}, destroy() {} };
  const coreField = createCoreField();
  const refraction=createRefractionPass();
  let surge=0,surgeProgress=0,lightTime=-Infinity;
  const orbitalImage = new Image();
  orbitalImage.decoding = 'async';
  orbitalImage.src = new URL('./assets/orbital-sphere.png',import.meta.url).href;
  const random = randomSource(34017);
  let width = 0, height = 0, dpr = 1, scale = 1, centerX = 0, centerY = 0;
  let frame = 0, refreshTimer = 0, destroyed = false, phase = 0, lastTime = 0, energy = 0, pressStrength = 0;
  let submitAge = Infinity, completeAge = Infinity, wakeUntil = 0, previousState = '', previousMotion = null, previousInteraction = null;
  const stateMix = { listening: 0, thinking: 0, speaking: 0 };
  let voiceLevel=0, fillProgress=1;
  const visual = { listening: 0, thinking: 0, progress: 1, completeProgress: -1 };
  const scratch = [0, 0];
  const accretionBuffers = Array.from({length:11},()=>new Float32Array(87*2));
  const currentBuffer = new Float32Array(25*4);
  const photonTrails=Array.from({length:7},(_,i)=>({
    a:190+i*11,b:157+i*10,tilt:DISK_TILT+i*.035,
    offset:i*TAU/7,rate:.75+(i%3)*.18,extent:.34+(i%2)*.14,
    points:new Float32Array(25*2),
  }));
  const satellitePositions = Array.from({length: 3}, () => ({x: 0, y: 0, r: 0, depth: 0}));
  const pointer = { x: 0, y: 0, clientX: null, clientY: null, targetX: 0, targetY: 0, presence: 0, targetPresence: 0 };
  const satellites = [
    { a: 192, b: 139, tilt: 35 * Math.PI / 180, angle: 3.294, period: 16, direction: 1, radius: 11.4 },
    { a: 206, b: 149, tilt: -27 * Math.PI / 180, angle: 3.062, period: 21, direction: 1, radius: 12.1 },
    { a: 164, b: 124, tilt: 17 * Math.PI / 180, angle: .435, period: 14, direction: 1, radius: 12 },
  ];
  const particles = Array.from({ length: 225 }, (_, i) => ({
    angle: random() * TAU,
    radius: 110 + random() ** .78 * 109,
    speed: (random() - .5) * .085,
    squash: .88 + random() * .12,
    size: i % 37 === 0 ? 1.65 : .35 + random() * .67,
    alpha: .25 + random() * .62,
    offset: random() * TAU,
  }));
  const dust = Array.from({ length: 105 }, () => ({
    x: (random() - .5) * 800,
    y: (random() - .5) * 510,
    radius: .3 + random() * .65,
    alpha: .10 + random() * .42,
    phase: random() * TAU,
  }));
  const ribbons = [
    { p: [[-740,-91],[-539,-214],[-451,-218],[-334,-99],[-236,-77],[-140,-80],[-50,-37]], spread: 17, bend: 16, alpha: .54, strands: 19 },
    { p: [[-795,85],[-608,-136],[-473,-50],[-370,40],[-208,6],[-94,-22],[20,15]], spread: 23, bend: 30, alpha: .27, strands: 12 },
    { p: [[-850,130],[-555,51],[-402,5],[-248,-18],[-177,-46],[-115,-93],[-37,-115]], spread: 13, bend: 17, alpha: .32, strands: 9 },
    { p: [[-236,-310],[-235,-252],[-206,-192],[-158,-158],[-78,-132],[-28,-59]], spread: 24, bend: 19, alpha: .62, strands: 20 },
    { p: [[-166,-365],[-192,-280],[-170,-197],[-99,-167],[-39,-108],[9,-14]], spread: 16, bend: 14, alpha: .29, strands: 11 },
    { p: [[-54,48],[-118,85],[-166,145],[-245,164],[-308,198],[-418,280]], spread: 29, bend: 24, alpha: .38, strands: 16 },
    { p: [[-62,24],[-155,90],[-185,165],[-240,191],[-353,179],[-487,219]], spread: 23, bend: 15, alpha: .25, strands: 11 },
    { p: [[34,-112],[109,-81],[176,-22],[236,-48],[304,-38],[384,29],[488,89],[656,130]], spread: 23, bend: 24, alpha: .55, strands: 21 },
    { p: [[64,-14],[184,-73],[259,-74],[331,22],[474,129],[636,231],[848,221]], spread: 31, bend: 14, alpha: .34, strands: 15 },
    { p: [[24,77],[103,115],[182,137],[228,187],[271,213],[356,228],[438,352]], spread: 25, bend: 22, alpha: .51, strands: 19 },
    { p: [[8,105],[131,169],[222,161],[257,185],[311,255],[350,368]], spread: 19, bend: 21, alpha: .25, strands: 12 },
    { p: [[51,-17],[112,-93],[170,-125],[202,-160],[179,-203],[107,-215]], spread: 14, bend: 13, alpha: .22, strands: 10 },
    { p: [[-242,-178],[-180,-154],[-127,-167],[-72,-129],[-25,-79]], spread: 11, bend: 10, alpha: .54, strands: 10 },
    { p: [[-151,91],[-106,106],[-78,152],[-19,136],[21,99],[0,43]], spread: 13, bend: 10, alpha: .45, strands: 10 },
    { p: [[126,46],[174,-44],[136,-128],[91,-144],[58,-90]], spread: 11, bend: 10, alpha: .44, strands: 8 },
  ].map((ribbon, i) => ({
    ...ribbon,
    inkStrength: [.40,.19,0,.78,.28,.39,0,.38,.20,.53,0,.26,.58,.50,.56][i],
    phase: i * 1.71,
    samples: Array.from({ length: 88 }, (_, n) => sampleCurve(ribbon.p, n / 87)),
    surface: new Float32Array(88 * 12),
    major: ribbon.alpha >= .38 && ribbon.spread >= 16,
  }));

  const wavePaths = [
    [[-705,-304],[-558,-311],[-431,-225],[-350,-20],[-181,64],[20,5]],
    [[-777,-114],[-599,-97],[-441,11],[-282,108],[-152,66],[49,24]],
    [[-778,84],[-519,114],[-324,140],[-126,61],[45,-8]],
    [[-194,-185],[-306,-199],[-428,-150],[-349,-48],[-179,-73],[41,-32]],
    [[85,-179],[194,-206],[279,-124],[247,12],[367,148],[499,147]],
  ].map(points => Array.from({length: 95}, (_, j) => sampleCurve(points, j / 94)));
  orbitalImage.onload = () => invalidate();

  function requestFrame() {
    if (!destroyed && !document.hidden && !frame) frame = requestAnimationFrame(render);
  }
  function invalidate() {
    wakeUntil = performance.now() + 420;
    clearTimeout(refreshTimer); refreshTimer = 0;
    requestFrame();
  }
  function resize() {
    width = window.innerWidth; height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const layout = sceneLayout(width, height);
    scale = layout.scale; centerX = layout.x; centerY = layout.y;
    if (pointer.clientX !== null) {
      pointer.targetX = (pointer.clientX - centerX) / scale;
      pointer.targetY = (pointer.clientY - centerY) / scale;
    }
    invalidate();
  }
  function onPointer(event) {
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.targetX = (event.clientX - centerX) / scale;
    pointer.targetY = (event.clientY - centerY) / scale;
    pointer.targetPresence = 1;
    invalidate();
  }
  function onLeave() { pointer.targetPresence = 0; invalidate(); }

  // The rim and nearby plotted geometry share the core's material transport.
  // A broader, weaker field carries that displacement into the distant ribbons.
  function warp(x, y, strength = 1, out = scratch) {
    if (pointer.presence < .001) { out[0] = x; out[1] = y; return out; }
    const material = coreField.displacePoint(x, y);
    const dx = x - pointer.x, dy = y - pointer.y;
    const distance = Math.hypot(dx, dy);
    const falloff = Math.max(0, 1 - distance / 190);
    const influence = falloff * falloff * pointer.presence * strength;
    const pull = influence * 7 / Math.max(distance, 22);
    const connection = clamp((225 - Math.hypot(x,y)) / 100, 0, 1) * strength;
    out[0] = x + (material[0] - x) * connection + dx * pull - dy * influence * .035;
    out[1] = y + (material[1] - y) * connection + dy * pull + dx * influence * .035;
    return out;
  }
  // A permanent lens bends the distant scene first; cursor transport then acts
  // on that apparent position, so the two fields never fight over the same ray.
  function lensPoint(x, y, strength = 1, out = scratch) {
    const radius = Math.hypot(x,y);
    if(radius<.01){out[0]=x;out[1]=y;return out;}
    const angle=Math.atan2(y,x);
    const radial=gaussian((radius-119)/68);
    const tangential=gaussian((radius-145)/97);
    const apparentRadius=radius+25*radial*strength;
    const apparentAngle=angle+.28*Math.sin(2*(angle-DISK_TILT))*tangential*strength;
    out[0]=Math.cos(apparentAngle)*apparentRadius;
    out[1]=Math.sin(apparentAngle)*apparentRadius;
    return out;
  }
  function filamentWarp(x,y,strength=1,out=scratch) {
    const lensed=lensPoint(x,y,strength,out);
    const lx=lensed[0],ly=lensed[1],distance=Math.hypot(x,y);
    const depth=clamp((distance-145)/360,0,1);
    const px=clamp(pointer.x/420,-1,1)*pointer.presence,py=clamp(pointer.y/300,-1,1)*pointer.presence;
    return warp(lx+px*depth*9,ly+py*depth*7,strength,out);
  }
  function ribbonEdge(ribbon, j, offset, flutter = 0) {
    const s = ribbon.surface, i = j * 12;
    const displacement = offset * s[i+6] + flutter;
    return filamentWarp(s[i] + s[i+4] * displacement, s[i+1] + s[i+5] * displacement);
  }
  function ribbonAlong(ribbon,position,offset=0) {
    const s=ribbon.surface,j=clamp(position,0,87),a=Math.floor(j)*12,b=Math.min(87,Math.ceil(j))*12,u=j-Math.floor(j);
    const spread=mix(s[a+6],s[b+6],u)*offset;
    return filamentWarp(mix(s[a],s[b],u)+mix(s[a+4],s[b+4],u)*spread,
      mix(s[a+1],s[b+1],u)+mix(s[a+5],s[b+5],u)*spread);
  }
  function drawRibbonSignal(ribbon, index, time) {
    const submission = submitAge < 1.35;
    const outerFirst = Math.hypot(...ribbon.samples[0]) > Math.hypot(...ribbon.samples[87]);
    let progress, alpha;
    if (submission) {
      progress = clamp((submitAge - index * .085) / 1.04, 0, 1);
      alpha = Math.sin(progress * Math.PI) * .70;
    } else {
      progress = (time * .19 + index * .173) % 1;
      alpha = Math.sin(progress * Math.PI) * (.74+stateMix.thinking*.18);
    }
    const head = (outerFirst ? progress : 1-progress) * 87;
    const tail = clamp(head + (outerFirst ? -20 : 20), 0, 87);
    if(alpha<.015||Math.abs(head-tail)<.2)return;
    const count=width<=600?12:20,buffer=currentBuffer;
    for(let j=0;j<=count;j++) {
      const q=ribbonAlong(ribbon,mix(tail,head,j/count),-.10);
      buffer[j*4]=q[0];buffer[j*4+1]=q[1];
    }
    const ink=ctx.createLinearGradient(buffer[0],buffer[1],buffer[count*4],buffer[count*4+1]);
    ink.addColorStop(0,'rgba(14,28,50,0)');ink.addColorStop(.52,`rgba(14,28,50,${alpha*.28})`);
    ink.addColorStop(1,`rgba(14,28,50,${alpha*.54})`);
    ctx.beginPath();
    for(let j=0;j<=count;j++) {
      const i=j*4,before=Math.max(0,j-1)*4,after=Math.min(count,j+1)*4;
      const dx=buffer[after]-buffer[before],dy=buffer[after+1]-buffer[before+1],length=Math.hypot(dx,dy)||1;
      const size=(j/count)**1.4*1.8;
      buffer[i+2]=-dy/length*size;buffer[i+3]=dx/length*size;
      if(!j)ctx.moveTo(buffer[i],buffer[i+1]);else ctx.lineTo(buffer[i],buffer[i+1]);
    }
    ctx.strokeStyle=ink;ctx.lineWidth=5.8;ctx.stroke();
    const light=ctx.createLinearGradient(buffer[0],buffer[1],buffer[count*4],buffer[count*4+1]);
    light.addColorStop(0,'rgba(255,255,255,0)');light.addColorStop(.45,`rgba(255,255,255,${alpha*.23})`);
    light.addColorStop(1,`rgba(255,255,255,${alpha})`);
    ctx.beginPath();
    for(let j=0;j<=count;j++){const i=j*4;if(!j)ctx.moveTo(buffer[i]+buffer[i+2],buffer[i+1]+buffer[i+3]);else ctx.lineTo(buffer[i]+buffer[i+2],buffer[i+1]+buffer[i+3]);}
    for(let j=count;j>=0;j--){const i=j*4;ctx.lineTo(buffer[i]-buffer[i+2],buffer[i+1]-buffer[i+3]);}
    ctx.closePath();ctx.fillStyle=light;ctx.fill();
    ctx.beginPath();ctx.arc(buffer[count*4],buffer[count*4+1],1.5,0,TAU);ctx.fillStyle=`rgba(255,255,255,${alpha})`;ctx.fill();
  }
  function drawRibbons(time) {
    ctx.lineCap = 'round';
    const breath = Math.sin(time*.7)*1.5*(1-stateMix.listening) + Math.sin(time*3.2)*4*stateMix.listening + voiceLevel*22;
    const sampleStep = width <= 600 ? 2 : 1;
    for (let n=0;n<ribbons.length;n++) {
      const ribbon = ribbons[n], s = ribbon.surface, major = ribbon.major;
      // Reuse a fixed geometry buffer; all strands share coherent surface folds.
      for (let j=0;j<88;j++) {
        const base=ribbon.samples[j], t=j/87, i=j*12;
        const before=ribbon.samples[Math.max(0,j-1)], after=ribbon.samples[Math.min(87,j+1)];
        const dx=after[0]-before[0], dy=after[1]-before[1], length=Math.hypot(dx,dy)||1;
        const envelope=Math.sin(Math.PI*t)**.85;
        const inner=gaussian((Math.hypot(base[0],base[1])-142)/135);
        const outerWave=Math.sin(t*4.8-time*.68+ribbon.phase);
        const innerWave=Math.sin(t*6-time*2.20+ribbon.phase);
        const outerDrift=Math.sin(time*.52+ribbon.phase*.6);
        const innerDrift=Math.sin(time*1.44+ribbon.phase*.6);
        const displacement=(mix(outerWave,innerWave,inner)*ribbon.bend*(1.78-inner*.88) +
          mix(outerDrift,innerDrift,inner)*(26+breath)*(1-inner*.54))*envelope*(1-surge*.30)*(1+energy*.16+voiceLevel*.72) + Math.sin(t*12-time*5.2+ribbon.phase)*voiceLevel*22*envelope;
        s[i]=base[0]-dy/length*displacement;s[i+1]=base[1]+dx/length*displacement;
        s[i+2]=t;s[i+3]=envelope;
      }
      for(let j=0;j<88;j++) {
        const i=j*12, before=Math.max(0,j-1)*12, after=Math.min(87,j+1)*12;
        const dx=s[after]-s[before],dy=s[after+1]-s[before+1],length=Math.hypot(dx,dy)||1;
        const inner=gaussian((Math.hypot(s[i],s[i+1])-142)/135);
        const twist=mix(Math.sin(s[i+2]*3.4-time*.45+ribbon.phase*.55),
          Math.sin(s[i+2]*4.2-time*1.50+ribbon.phase*.55),inner);
        s[i+4]=-dy/length;s[i+5]=dx/length;s[i+7]=twist;
        s[i+6]=ribbon.spread*(.22+s[i+3]*.78)*(major?1.42+twist*.30:.86+twist*.34);
        let q=ribbonEdge(ribbon,j,-1);s[i+8]=q[0];s[i+9]=q[1];
        q=ribbonEdge(ribbon,j,1);s[i+10]=q[0];s[i+11]=q[1];
      }
      // Continuous width bands describe the folded surface without quad seams.
      const bands=width<=600?(major?5:3):(major?7:5);
      const tones=[[184,189,192,.025],[151,158,162,.075],[102,111,116,.20],
        [43,50,56,.33],[29,35,39,.49],[249,250,251,.45],[245,247,249,.06]];
      for(let band=0;band<bands;band++) {
        const low=band/bands,high=(band+1)/bands;
        const position=(band+.5)/bands*6,a=Math.floor(position),b=Math.min(6,a+1),u=position-a;
        const rgb=[0,1,2].map(channel=>Math.round(mix(tones[a][channel],tones[b][channel],u))).join(',');
        const alpha=mix(tones[a][3],tones[b][3],u)*ribbon.alpha*(major?1:.60);
        const shade=ctx.createLinearGradient(s[0],s[1],s[87*12],s[87*12+1]);
        for(const [stop,weight] of [[0,.025],[.19,.40],[.48,1],[.83,.70],[1,.025]])
          shade.addColorStop(stop,`rgba(${rgb},${alpha*weight})`);
        ctx.beginPath();
        for(let j=0;j<88;j+=sampleStep) {
          const i=j*12,x=mix(s[i+8],s[i+10],low),y=mix(s[i+9],s[i+11],low);
          if(!j)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        }
        const last=87*12;ctx.lineTo(mix(s[last+8],s[last+10],low),mix(s[last+9],s[last+11],low));
        for(let j=87;j>=0;j-=sampleStep) {
          const i=j*12;ctx.lineTo(mix(s[i+8],s[i+10],high),mix(s[i+9],s[i+11],high));
        }
        ctx.lineTo(mix(s[8],s[10],high),mix(s[9],s[11],high));
        ctx.closePath();ctx.fillStyle=shade;ctx.globalAlpha=major?.80:.48;ctx.fill();ctx.globalAlpha=1;
      }
      for(let strand=0;strand<ribbon.strands;strand++) {
        if(width<=600 && strand%2 && strand!==Math.floor(ribbon.strands*.38))continue;
        const offset=(strand/(ribbon.strands-1)-.5)*2;
        const foreground=ribbon.inkStrength>0&&(strand===Math.floor(ribbon.strands*.38)||
          (ribbon.inkStrength>=.4&&strand===Math.floor(ribbon.strands*.72)));
        const middle=!foreground&&strand%4===1;
        ctx.beginPath();
        for(let j=0;j<88;j+=sampleStep) {
          const i=j*12,inner=gaussian((Math.hypot(s[i],s[i+1])-142)/135);
          const flutter=mix(Math.sin(s[i+2]*15-time*1.30+strand*.6),
            Math.sin(s[i+2]*17-time*4.20+strand*.6),inner)*s[i+3]*(foreground?.65:1.1+Math.abs(offset)*.9);
          const q=ribbonEdge(ribbon,j,offset,flutter);
          if(!j)ctx.moveTo(q[0],q[1]);else ctx.lineTo(q[0],q[1]);
        }
        const weight=1-Math.abs(offset)*.65;
        if(foreground) {
          const ink=ctx.createLinearGradient(s[0],s[1],s[87*12],s[87*12+1]);
          const opacity=ribbon.inkStrength*weight*1.22,crest=strand<ribbon.strands*.5?.44:.68;
          ink.addColorStop(0,`rgba(13,25,44,${opacity*.02})`);
          ink.addColorStop(.20,`rgba(13,25,44,${opacity*.19})`);
          ink.addColorStop(crest,`rgba(13,25,44,${opacity})`);
          ink.addColorStop(.86,`rgba(13,25,44,${opacity*.48})`);
          ink.addColorStop(1,`rgba(13,25,44,${opacity*.08})`);
          ctx.strokeStyle=ink;ctx.lineWidth=strand<ribbon.strands*.5?(ribbon.inkStrength>=.7?1.3:1.0):.65;
        } else {
          ctx.strokeStyle=`rgba(${middle?'55,58,60':'105,109,113'},${ribbon.alpha*weight*(middle?.27:.06)})`;
          ctx.lineWidth=.35+(strand%3)*.12;
        }
        ctx.stroke();
        if(foreground&&ribbon.inkStrength>=.4&&strand<ribbon.strands*.5) {
          for(const fraction of [.28,.48,.70]) {
            const q=ribbonEdge(ribbon,Math.round(fraction*87),offset);
            ctx.beginPath();ctx.arc(q[0],q[1],.62,0,TAU);ctx.fillStyle=`rgba(12,24,41,${ribbon.inkStrength*.8})`;ctx.fill();
          }
        }
      }
      if(n===0||n===2||n===3||n===5||n===7||n===9||n===12)drawRibbonSignal(ribbon,n,time);
    }
    ctx.strokeStyle='rgba(56,84,126,.20)';ctx.lineWidth=.58;
    for(let n=0;n<wavePaths.length;n++) {
      ctx.beginPath();
      for(let j=0;j<95;j+=sampleStep) {
        const p=wavePaths[n][j],inner=gaussian((Math.hypot(p[0],p[1])-142)/135);
        const wave=mix(Math.sin(j/94*TAU-time*.56+n),Math.sin(j/94*TAU*1.2-time*1.64+n),inner);
        const q=filamentWarp(p[0],p[1]+wave*31*(1-inner*.55));
        if(!j)ctx.moveTo(q[0],q[1]);else ctx.lineTo(q[0],q[1]);
      }
      ctx.stroke();
    }
  }
  function accretionPoint(angle,track,time,rear,out=scratch,imageOffset=0) {
    const sin=Math.sin(angle),cos=Math.cos(angle),depth=Math.abs(sin);
    const radius=195+track*4.3;
    const shear=Math.sin(angle*4-time*(1.55-track*.025)+track*.63)*1.25*depth;
    const x=cos*radius;
    // The rear plane appears again above the shadow; its near-side image is
    // compressed below it. Both are drawn before the core masks the scene.
    const y=sin*(rear?57:39)+(rear?-77:67)*depth**1.7+track*(rear?2.4:1.4)+shear;
    const cosine=Math.cos(DISK_TILT),sine=Math.sin(DISK_TILT);
    const lensed=lensPoint(x*cosine-y*sine,x*sine+y*cosine,.93,out);
    const apparentRadius=Math.hypot(lensed[0],lensed[1])||1;
    const imageScale=1+imageOffset/apparentRadius;
    return warp(lensed[0]*imageScale,lensed[1]*imageScale,.93,out);
  }
  function drawAccretion(time) {
    const count=width<=600?54:86;
    // Continuous nested skins form a single folded volume. Light veins sit on it.
    const skins=[['47,53,58',.12],['47,53,58',.26],['27,32,36',.40],['255,255,255',.71],['82,90,95',.22],['255,255,255',.19]];
    for(const rear of [true,false]) {
      const start=rear?Math.PI:0,tracks=rear?7:4;
      for(let track=0;track<tracks;track++) {
        const buffer=accretionBuffers[(rear?0:7)+track],offset=track-(tracks-1)/2;
        for(let j=0;j<=count;j++) {const q=accretionPoint(start+j/count*Math.PI,offset,time,rear);buffer[j*2]=q[0];buffer[j*2+1]=q[1];}
      }
      for(let track=0;track<tracks-1;track++) {
        const a=accretionBuffers[(rear?0:7)+track],b=accretionBuffers[(rear?0:7)+track+1];
        const [rgb,opacity]=skins[rear?track:track+1];
        const left=a[0]<a[count*2]?0:count*2,right=left?0:count*2;
        const gradient=ctx.createLinearGradient(a[left],a[left+1],a[right],a[right+1]);
        for(const [stop,weight] of [[0,0],[.12,.40],[.29,1],[.56,.65],[.83,.17],[1,0]])gradient.addColorStop(stop,`rgba(${rgb},${opacity*(rear?1:.42)*weight*(1+surge*.45)})`);
        ctx.beginPath();ctx.moveTo(a[0],a[1]);for(let j=1;j<=count;j++)ctx.lineTo(a[j*2],a[j*2+1]);
        for(let j=count;j>=0;j--)ctx.lineTo(b[j*2],b[j*2+1]);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
      }
      for(let vein=0;vein<(rear?4:2);vein++) {
        const buffer=accretionBuffers[(rear?0:7)+(rear?vein+1:vein+1)];
        const head=(time*(.17+vein*.03)+vein*.27)%1,from=Math.max(0,Math.floor(head*count)-14),to=Math.min(count,Math.ceil(head*count));
        if(to<=from)continue;
        const gradient=ctx.createLinearGradient(buffer[from*2],buffer[from*2+1],buffer[to*2],buffer[to*2+1]);
        const alpha=Math.sin(head*Math.PI)*(rear?.90:.35);
        gradient.addColorStop(0,'rgba(255,255,255,0)');gradient.addColorStop(1,`rgba(255,255,255,${alpha})`);
        ctx.beginPath();ctx.moveTo(buffer[from*2],buffer[from*2+1]);for(let j=from+1;j<=to;j++)ctx.lineTo(buffer[j*2],buffer[j*2+1]);
        ctx.lineWidth=.8+vein*.1;ctx.strokeStyle=gradient;ctx.stroke();
      }
    }
  }
  function traceOrbit(a,b,tilt,start,end,strength=.46) {
    const count=width<=600?44:68,cos=Math.cos(tilt),sin=Math.sin(tilt);
    ctx.beginPath();
    for(let i=0;i<=count;i++) {
      const angle=start+i/count*(end-start),x=Math.cos(angle)*a,y=Math.sin(angle)*b;
      const q=warp(x*cos-y*sin,x*sin+y*cos,strength);
      if(!i)ctx.moveTo(q[0],q[1]);else ctx.lineTo(q[0],q[1]);
    }
  }
  function drawGravityEffects(time) {
    if(surge>0) {
      const radius=126+surgeProgress*405;
      ctx.save();ctx.globalAlpha=surge;
      traceOrbit(radius,radius*.94,DISK_TILT,-3.03,2.8,.22);
      ctx.lineWidth=2.4;ctx.strokeStyle='rgba(19,38,67,.17)';ctx.stroke();
      ctx.lineWidth=.8;ctx.strokeStyle='rgba(255,255,255,.62)';ctx.stroke();ctx.restore();
    }
    const count=width<=600?14:24,trailCount=width<=600?4:photonTrails.length;
    for(let n=0;n<trailCount;n++) {
      const trail=photonTrails[n],buffer=trail.points,head=trail.offset+time*trail.rate;
      const cosine=Math.cos(trail.tilt),sine=Math.sin(trail.tilt);
      for(let j=0;j<=count;j++) {
        const angle=head-trail.extent*(1-j/count),x=Math.cos(angle)*trail.a,y=Math.sin(angle)*trail.b;
        const q=filamentWarp(x*cosine-y*sine,x*sine+y*cosine,.58);
        buffer[j*2]=q[0];buffer[j*2+1]=q[1];
      }
      const bright=(1+Math.cos(Math.atan2(buffer[count*2+1],buffer[count*2])-BRIGHT_ANGLE))*.5;
      const ink=ctx.createLinearGradient(buffer[0],buffer[1],buffer[count*2],buffer[count*2+1]);
      ink.addColorStop(0,'rgba(16,31,54,0)');ink.addColorStop(.6,`rgba(16,31,54,${.20+bright*.14})`);
      ink.addColorStop(1,`rgba(16,31,54,${.44+bright*.16})`);
      ctx.beginPath();ctx.moveTo(buffer[0],buffer[1]);for(let j=1;j<=count;j++)ctx.lineTo(buffer[j*2],buffer[j*2+1]);
      ctx.lineWidth=3.1;ctx.strokeStyle=ink;ctx.stroke();
      const light=ctx.createLinearGradient(buffer[0],buffer[1],buffer[count*2],buffer[count*2+1]);
      light.addColorStop(0,'rgba(255,255,255,0)');light.addColorStop(.45,'rgba(255,255,255,.18)');
      light.addColorStop(1,`rgba(255,255,255,${.68+bright*.28})`);
      ctx.lineWidth=1.05;ctx.strokeStyle=light;ctx.stroke();
    }
    // Broken expanding arcs cross the negative space without outlining a globe.
    for(let wave=0;wave<2;wave++) {
      const progress=(time*.13+wave*.5)%1,radius=180+progress**1.08*205;
      const alpha=Math.sin(progress*Math.PI)*.16;
      const shade=ctx.createLinearGradient(-radius,-radius,radius,radius);
      shade.addColorStop(0,`rgba(22,44,78,${alpha})`);shade.addColorStop(.55,`rgba(22,44,78,${alpha*.5})`);
      shade.addColorStop(1,`rgba(22,44,78,${alpha*.08})`);
      for(const range of [[-2.98,-.36],[.42,2.57]]) {
        traceOrbit(radius,radius*.93,DISK_TILT+wave*.12,range[0],range[1],.20);
        ctx.lineWidth=1.15;ctx.strokeStyle=shade;ctx.stroke();
        ctx.lineWidth=.38;ctx.strokeStyle=`rgba(255,255,255,${alpha*.95})`;ctx.stroke();
      }
    }
  }
  function drawOrbits(time) {
    ctx.lineWidth = .45;
    for (let ring = 0; ring < 6; ring++) {
      const radius = 134 + ring * 8.1;
      const rotation = ring * .28 + time * (ring % 2 ? .075 : -.062);
      traceOrbit(radius,radius*(.97-(ring%5)*.012),rotation,.10+ring*.31,4.5+ring*.30);
      ctx.strokeStyle = `rgba(62,93,139,${ring % 3 === 0 ? .095 : .048})`;
      ctx.stroke();
    }
    // Inclined orbital ellipses bring a scientific wire-frame quality to the halo.
    for (let i = 0; i < 3; i++) {
      traceOrbit(195-i*6,73+i*12,i*.47+.2+time*.024,.2,TAU-.26);
      ctx.strokeStyle = `rgba(70,104,156,${i % 2 ? .035 : .055})`;
      ctx.lineWidth = .42; ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0,-244); ctx.lineTo(0,237);
    ctx.strokeStyle = 'rgba(43,65,97,.17)'; ctx.lineWidth = .45; ctx.stroke();
    ctx.setLineDash([1, 13]);
    ctx.beginPath(); ctx.moveTo(-350,0); ctx.lineTo(258,0);
    ctx.strokeStyle = 'rgba(51,76,113,.15)'; ctx.stroke(); ctx.setLineDash([]);
    for (const y of [-190,-153,-135,135,168]) {
      ctx.beginPath(); ctx.arc(0,y,y === -135 ? 1.7 : 2.8,0,TAU);
      ctx.fillStyle = 'rgba(9,19,33,.46)'; ctx.fill();
    }
    const particleStep=width<=600?2:1;
    for(let i=0;i<particles.length;i+=particleStep) {
      const particle=particles[i],a=particle.angle+time*particle.speed*2.5;
      const r = particle.radius + Math.sin(time * .75 + particle.offset) * 12 - stateMix.listening * Math.sin(time*3.2+particle.offset*.25)*3.5;
      if(i%19===0) {
        const tail=a-Math.sign(particle.speed)*.11;
        let headX=0,headY=0,tailX=0,tailY=0;
        ctx.beginPath();
        for(let j=0;j<=6;j++) {
          const angle=mix(tail,a,j/6),q=filamentWarp(Math.cos(angle)*r,Math.sin(angle)*r*particle.squash,.7);
          if(!j){tailX=q[0];tailY=q[1];ctx.moveTo(q[0],q[1]);}else ctx.lineTo(q[0],q[1]);
          headX=q[0];headY=q[1];
        }
        const shade=ctx.createLinearGradient(tailX,tailY,headX,headY);
        shade.addColorStop(0,'rgba(12,24,42,0)');shade.addColorStop(1,`rgba(12,24,42,${particle.alpha*.68})`);
        ctx.strokeStyle=shade;ctx.lineWidth=.65;ctx.stroke();
      }
      const p = filamentWarp(Math.cos(a) * r, Math.sin(a) * r * particle.squash, .7);
      ctx.beginPath(); ctx.arc(p[0],p[1],particle.size,0,TAU);
      ctx.fillStyle = `rgba(11,21,37,${particle.alpha})`; ctx.fill();
    }
    for(let i=0;i<dust.length;i+=particleStep) {
      const particle=dust[i];
      const progress=(time*.034+particle.phase/TAU)%1;
      const radius=mix(Math.max(125,Math.hypot(particle.x,particle.y)),84,progress);
      const angle=Math.atan2(particle.y,particle.x)+time*.028;
      const p = filamentWarp(Math.cos(angle)*radius+Math.sin(time*.38+particle.phase)*8,
        Math.sin(angle)*radius+Math.cos(time*.32+particle.phase)*7,.6);
      ctx.beginPath(); ctx.arc(p[0],p[1],particle.radius,0,TAU);
      ctx.fillStyle = `rgba(18,36,64,${particle.alpha*Math.sin(progress*Math.PI)**.6})`; ctx.fill();
    }
    for (const satellite of satellites) {
      traceOrbit(satellite.a,satellite.b,satellite.tilt,0,TAU,.28);
      ctx.strokeStyle = 'rgba(54,81,121,.15)'; ctx.lineWidth = .45; ctx.stroke();
    }
  }
  function drawCore(surface) {
    const bounds=coreField.bounds;
    ctx.drawImage(surface,-bounds,-bounds,bounds*2,bounds*2);
  }
  function drawSatellite(satellite) {
    if(!orbitalImage.complete||!orbitalImage.naturalWidth)return;
    const p=warp(satellite.x,satellite.y,.28),depth=(satellite.depth+1)*.5;
    ctx.save();ctx.translate(p[0],p[1]);ctx.imageSmoothingQuality='high';
    ctx.globalAlpha=.44+depth*.56;
    ctx.filter=`blur(${(2.2-depth*2.05)*dpr*scale}px)`;
    const extent=satellite.r/.891;
    ctx.drawImage(orbitalImage,-extent,-extent,extent*2,extent*2);ctx.restore();
  }
  function drawGlint(time) {
    const x = 229 + Math.sin(time * .36) * 9, y = -183 + Math.cos(time * .31) * 8;
    const flare = ctx.createRadialGradient(x,y,0,x,y,27);
    flare.addColorStop(0,'rgba(255,255,255,.96)'); flare.addColorStop(.16,'rgba(255,255,255,.68)');
    flare.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle = flare; ctx.fillRect(x-27,y-27,54,54);
    ctx.strokeStyle = 'rgba(255,255,255,.42)'; ctx.lineWidth = .6;
    ctx.beginPath(); ctx.moveTo(x-20,y); ctx.lineTo(x+20,y); ctx.moveTo(x,y-23); ctx.lineTo(x,y+23); ctx.stroke();
    ctx.beginPath(); ctx.arc(202,-166,4.2,0,TAU); ctx.fillStyle = 'rgba(54,81,121,.36)'; ctx.fill();
  }
  function render(timestamp) {
    frame=0;
    if(destroyed||document.hidden)return;
    const delta=lastTime?Math.max(0,Math.min((timestamp-lastTime)/1000,.05)):1/60;
    lastTime=timestamp;
    const state=getState(),motion=getMotion(),interaction=getInteraction(),blend=1-Math.exp(-delta/.24);
    if(state!==previousState||motion!==previousMotion||interaction!==previousInteraction){
      previousState=state;previousMotion=motion;previousInteraction=interaction;wakeUntil=timestamp+900;
    }
    stateMix.listening=mix(stateMix.listening,state==='listening'?1:0,blend);
    stateMix.speaking=mix(stateMix.speaking,state==='speaking'?1:0,blend);
    voiceLevel=mix(voiceLevel,clamp(getSpeechLevel(),0,1)*stateMix.speaking,1-Math.exp(-delta/.045));
    fillProgress=mix(fillProgress,clamp(getProgress(),0,1),1-Math.exp(-delta/.55));
    stateMix.thinking=mix(stateMix.thinking,state==='thinking'?1:0,blend);
    if(motion)phase+=delta*(.90+stateMix.listening*.10+stateMix.thinking*.36+surge*.55+voiceLevel*.9);
    surgeProgress=clamp((phase%17-10.5)/3.5,0,1);
    surge=Math.sin(surgeProgress*Math.PI)**3;
    if(timestamp-lightTime>80){onLight(.08+.035*(.5+.5*Math.sin(phase*.72))+surge*.13,28+Math.sin(phase*.28)*14);lightTime=timestamp;}
    if(motion){submitAge+=delta;completeAge+=delta;}else{submitAge=Infinity;completeAge=Infinity;}
    pointer.x=pointer.targetX;pointer.y=pointer.targetY;
    pointer.presence=interaction?pointer.targetPresence:0;
    pressStrength=clamp((147-Math.hypot(pointer.x,pointer.y))/27,0,1)*pointer.presence;
    energy=mix(energy,clamp(Number(getEnergy())||0,0,1),1-Math.exp(-delta/.075));
    visual.listening=stateMix.listening+voiceLevel*.8;visual.thinking=stateMix.thinking;visual.progress=fillProgress;
    visual.completeProgress=completeAge<1.25?completeAge/1.25:-1;
    // Advance transport once, before any geometry samples its shared displacement.
    const surface=coreField.render(pointer,pressStrength,energy,delta,phase,visual);
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    ctx.translate(centerX,centerY);ctx.scale(scale,scale);
    drawRibbons(phase);drawOrbits(phase);drawGravityEffects(phase);
    refraction.draw(ctx,canvas,centerX,centerY,scale,dpr,phase);
    drawAccretion(phase);drawGlint(phase);
    for(let i=0;i<satellites.length;i++) {
      const satellite=satellites[i],position=satellitePositions[i];
      const angle=satellite.angle+phase*TAU/satellite.period*satellite.direction;
      const x=satellite.a*Math.cos(angle),y=satellite.b*Math.sin(angle);
      position.x=x*Math.cos(satellite.tilt)-y*Math.sin(satellite.tilt);
      position.y=x*Math.sin(satellite.tilt)+y*Math.cos(satellite.tilt);
      position.depth=Math.sin(angle);position.r=satellite.radius*(.94+position.depth*.14);
    }
    // Small visual separation prevents different orbital periods overlapping.
    for(let a=0;a<3;a++)for(let b=a+1;b<3;b++) {
      const p=satellitePositions[a],q=satellitePositions[b],dx=q.x-p.x,dy=q.y-p.y,d=Math.hypot(dx,dy);
      if(d>0&&d<29){const push=(29-d)*.5/d;p.x-=dx*push;p.y-=dy*push;q.x+=dx*push;q.y+=dy*push;}
    }
    for(const satellite of satellitePositions)if(satellite.depth<0)drawSatellite(satellite);
    drawCore(surface);
    for(const satellite of satellitePositions)if(satellite.depth>=0)drawSatellite(satellite);
    const cueActive=submitAge<1.35||completeAge<1.25;
    const settling=Math.abs(stateMix.listening-(state==='listening'?1:0))>.003||Math.abs(stateMix.thinking-(state==='thinking'?1:0))>.003;
    if(motion||state==='speaking'||state==='thinking'||cueActive||settling||timestamp<wakeUntil)requestFrame();
    else refreshTimer=setTimeout(()=>{refreshTimer=0;requestFrame();},180);
  }
  function onVisibility() {
    clearTimeout(refreshTimer);refreshTimer=0;lastTime=0;
    if(document.hidden){cancelAnimationFrame(frame);frame=0;}
    else invalidate();
  }
  resize();
  window.addEventListener('resize',resize,{passive:true});
  window.addEventListener('pointermove',onPointer,{passive:true});
  function onPointerUp(event){if(event.pointerType!=='mouse')onLeave();}
  window.addEventListener('pointerup',onPointerUp,{passive:true});
  window.addEventListener('pointercancel',onLeave,{passive:true});
  document.addEventListener('pointerleave',onLeave);
  document.addEventListener('visibilitychange',onVisibility);
  window.addEventListener('blur',onLeave);
  requestFrame();
  return {
    cue(type) {
      if(destroyed||!getMotion())return;
      if(type==='submit')submitAge=0;
      else if(type==='complete')completeAge=0;
      else return;
      invalidate();
    },
    destroy() {
      destroyed=true;cancelAnimationFrame(frame);clearTimeout(refreshTimer);
      orbitalImage.onload=null;
      window.removeEventListener('resize',resize);
      window.removeEventListener('pointermove',onPointer);
      window.removeEventListener('pointerup',onPointerUp);
      window.removeEventListener('pointercancel',onLeave);
      document.removeEventListener('pointerleave',onLeave);
      document.removeEventListener('visibilitychange',onVisibility);
      window.removeEventListener('blur',onLeave);
      coreField.destroy();refraction.destroy();
    },
  };
}
