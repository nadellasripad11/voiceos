import { createFluidSimulation } from './fluid-simulation.js';

const BOUNDS=176,SIZE=BOUNDS*4;
const TAU=Math.PI*2;

export function createCoreField({radius=112}={}) {
  const fluid=createFluidSimulation({resolution:160,bounds:BOUNDS,radius});
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=SIZE;
  const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:false,depth:false,preserveDrawingBuffer:true});
  const resources={shaders:[],program:null,buffer:null};
  function releaseGL() {
    if(!gl)return;
    if(resources.buffer)gl.deleteBuffer(resources.buffer);
    resources.shaders.forEach(shader=>gl.deleteShader(shader));
    if(resources.program)gl.deleteProgram(resources.program);
  }
  if(gl) {
    const vertex=`attribute vec2 a_position;varying vec2 v_uv;
      void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
    const fragment=`precision mediump float;
      varying vec2 v_uv;
      uniform vec2 u_pointer,u_direction;
      uniform float u_radius,u_bounds,u_opening,u_stretch,u_time,u_energy,u_listening,u_thinking,u_complete,u_progress;
      vec3 transported(vec2 world) {
        if(u_opening<.001)return vec3(world,1000.);
        vec2 d=world-u_pointer;
        float a=dot(d,u_direction)/u_stretch;
        float b=dot(d,vec2(-u_direction.y,u_direction.x))*u_stretch;
        float r=length(vec2(a,b)/48.)*48.;
        float angle=atan(b,a);
        float h=u_opening*(1.+.014*sin(angle*2.+u_time*.9)+.006*sin(angle*3.-u_time*.7));
        float rr=r/48.,hh=h/48.;
        float z=max(0.,rr*rr-hh*hh);
        for(int k=0;k<4;k++){
          float e=exp(-z);
          z=max(0.,z-(z+hh*hh*e-rr*rr)/(1.-hh*hh*e));
        }
        float factor=sqrt(z)*48./max(r,.0001);
        vec2 source=u_pointer+a*factor*u_stretch*u_direction+
          b*factor/u_stretch*vec2(-u_direction.y,u_direction.x);
        return vec3(source,r-h);
      }
      float lightStreak(float angle,float center,float distance,float offset,float width,float extent) {
        float arc=atan(sin(angle-center),cos(angle-center));
        return exp(-pow(arc/extent,2.))*exp(-pow((distance-offset)/width,2.));
      }
      void main(){
        vec2 world=(vec2(v_uv.x,1.-v_uv.y)-.5)*u_bounds*2.;
        vec3 material=transported(world);
        float outerSdf=length(material.xy)-u_radius;
        float sdf=max(outerSdf,-material.z);
        float black=1.-smoothstep(-.46,.46,sdf);
        float fillLine=u_radius*(1.-2.*clamp(u_progress,0.,1.));
        float fill=smoothstep(fillLine-1.2,fillLine+1.2,material.y);
        black*=mix(1.,fill,clamp(u_thinking,0.,1.));
        float r=length(world),angle=atan(world.y,world.x);
        // A stable bright side belongs to the light flow, never to the black body.
        float bright=pow(.5+.5*cos(angle+2.35),4.5);
        float listenWave=.5+.5*sin(u_time*3.2);
        float intensity=1.+u_listening*(.12+.24*listenWave)+u_thinking*.14+clamp(u_energy,0.,1.)*.09;
        float lightRipple=sin(angle*17.-u_time*.36)*.15+sin(angle*29.+u_time*.22)*.06;
        float primaryDistance=outerSdf-1.55-lightRipple;
        float primary=exp(-pow(primaryDistance/.58,2.))*(.12+.88*bright)*intensity;
        float soft=exp(-pow(primaryDistance/1.45,2.))*(.020+.115*bright)*intensity;
        float arcBreak=.32+.68*pow(.5+.5*cos(angle*3.-u_time*.19),2.);
        float secondary=exp(-pow((outerSdf-5.6-lightRipple*.55)/.52,2.))*(.05+.58*bright)*arcBreak;
        float tertiary=exp(-pow((outerSdf-9.3-lightRipple*.35)/.44,2.))*(.018+.40*bright)*arcBreak;
        float outerArc=exp(-pow((outerSdf-16.-lightRipple*.25)/.38,2.))*(.008+.25*bright)*arcBreak;
        // More and longer currents move along separate layers, with fixed rates.
        // State acceleration comes from the already accumulated scene phase.
        float streak=lightStreak(angle,u_time*.54+1.3,outerSdf,1.35,.34,.14)*.86+
          lightStreak(angle,u_time*.41-1.9,outerSdf,3.15,.43,.19)*.62+
          lightStreak(angle,u_time*.64+3.6,outerSdf,5.6,.48,.20)*.95+
          lightStreak(angle,u_time*.33-.4,outerSdf,9.3,.43,.24)*.82+
          lightStreak(angle,u_time*.47+2.2,outerSdf,16.,.47,.26)*.73+
          lightStreak(angle,u_time*.28-2.7,outerSdf,21.6,.54,.28)*.61;
        streak*=.16+.84*bright;
        // Contrast sits in distinct thin layers; there is no broad spherical bevel.
        float shoulder=exp(-pow((outerSdf-3.8-lightRipple*.65)/1.10,2.))*(.018+.58*bright);
        shoulder+=exp(-pow((outerSdf-6.7)/.65,2.))*(.016+.23*bright)*arcBreak;
        shoulder+=exp(-pow((outerSdf-10.4)/.64,2.))*(.009+.18*bright)*arcBreak;
        shoulder+=exp(-pow((outerSdf-17.2)/.70,2.))*.11*bright*arcBreak;
        float exterior=smoothstep(u_radius-1.,u_radius+.6,r);
        float white=clamp(primary+soft*(1.-primary)+secondary+tertiary+outerArc+streak,0.,1.)*exterior;
        float shade=shoulder*exterior;
        // Two staggered, broken photon echoes expand beyond the fixed horizon.
        for(int k=0;k<2;k++) {
          float progress=fract(u_time*.24+float(k)*.5);
          float envelope=pow(max(0.,sin(progress*3.14159265)),.85);
          float echoMask=(.18+.68*bright)*(.37+.63*pow(.5+.5*cos(angle*3.+float(k)*1.7),2.));
          float echoDistance=outerSdf-15.-progress*39.;
          float darkEcho=exp(-pow((echoDistance-1.5)/.78,2.))*envelope*echoMask*.39;
          float whiteEcho=exp(-pow(echoDistance/.62,2.))*envelope*echoMask*.64;
          shade=clamp(shade+darkEcho*exterior,0.,1.);
          white=clamp(white+whiteEcho*exterior,0.,1.);
        }
        if(u_complete>=0.) {
          float progress=clamp(u_complete,0.,1.);
          float envelope=sin(progress*3.14159265)*pow(1.-progress,.7)*.42;
          float ripple=exp(-pow((r-u_radius-5.-progress*48.)/1.1,2.))*envelope;
          shade=clamp(shade+ripple*.32,0.,1.);
          white=clamp(white+exp(-pow((r-u_radius-3.-progress*48.)/1.3,2.))*envelope,0.,1.);
        }
        float coronaAlpha=white+shade*(1.-white);
        float coronaRgb=white+shade*.27*(1.-white);
        float alpha=black+coronaAlpha*(1.-black);
        float rgb=coronaRgb*(1.-black)/max(alpha,.0001);
        gl_FragColor=vec4(vec3(rgb),alpha);
      }`;
    try {
      const compile=(type,source)=>{
        const shader=gl.createShader(type);if(!shader)throw new Error('Shader unavailable');
        resources.shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('Shader unavailable');
        return shader;
      };
      resources.program=gl.createProgram();if(!resources.program)throw new Error('Shader unavailable');
      gl.attachShader(resources.program,compile(gl.VERTEX_SHADER,vertex));
      gl.attachShader(resources.program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(resources.program);
      if(!gl.getProgramParameter(resources.program,gl.LINK_STATUS))throw new Error('Shader unavailable');
      gl.useProgram(resources.program);
      resources.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,resources.buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      const position=gl.getAttribLocation(resources.program,'a_position');
      gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      const uniform=name=>gl.getUniformLocation(resources.program,name);
      const uniforms=Object.fromEntries(['pointer','direction','radius','bounds','opening','stretch','time','energy','listening','thinking','complete','progress'].map(name=>[name,uniform(`u_${name}`)]));
      gl.uniform1f(uniforms.radius,radius);gl.uniform1f(uniforms.bounds,BOUNDS);gl.viewport(0,0,SIZE,SIZE);
      let disposed=false;
      return {
        bounds:BOUNDS,
        displacePoint:(x,y)=>fluid.displacePoint(x,y),
        render(pointer,strength,energy=0,delta=1/60,time,visual={}){
          if(disposed)return canvas;
          fluid.step(pointer,strength,delta,time);const state=fluid.getState();
          gl.uniform2f(uniforms.pointer,state.x,state.y);gl.uniform2f(uniforms.direction,state.dx,state.dy);
          gl.uniform1f(uniforms.opening,state.opening);gl.uniform1f(uniforms.stretch,state.stretch);
          gl.uniform1f(uniforms.time,state.time);gl.uniform1f(uniforms.energy,energy);
          gl.uniform1f(uniforms.listening,visual.listening||0);gl.uniform1f(uniforms.thinking,visual.thinking||0);
          gl.uniform1f(uniforms.progress,Number.isFinite(visual.progress)?visual.progress:1);
          gl.uniform1f(uniforms.complete,Number.isFinite(visual.completeProgress)?visual.completeProgress:-1);
          gl.drawArrays(gl.TRIANGLES,0,6);return canvas;
        },
        destroy(){if(disposed)return;disposed=true;fluid.destroy();releaseGL();},
      };
    } catch {releaseGL();}
  }

  // Canvas fallback renders the same transported density, with an exterior-only
  // corona underneath it. Shader compilation failure therefore keeps the effect.
  const fallback=document.createElement('canvas');fallback.width=fallback.height=SIZE;
  const ctx=fallback.getContext('2d');
  const grid=document.createElement('canvas');grid.width=grid.height=fluid.resolution;
  const gridCtx=grid.getContext('2d');const image=gridCtx.createImageData(fluid.resolution,fluid.resolution);
  let disposed=false;
  function contour(offset,time,start=0,end=TAU){
    ctx.beginPath();
    const samples=Math.max(4,Math.ceil(192*Math.abs(end-start)/TAU));
    for(let i=0;i<=samples;i++){
      const a=start+i/samples*(end-start);
      const irregular=Math.sin(a*17-time*.36)*.15+Math.sin(a*29+time*.22)*.06;
      const r=radius+offset+irregular;
      const p=fluid.displacePoint(Math.cos(a)*r,Math.sin(a)*r);
      if(!i)ctx.moveTo(...p);else ctx.lineTo(...p);
    }
    if(end-start>=TAU-.001)ctx.closePath();
  }
  return {
    bounds:BOUNDS,
    displacePoint:(x,y)=>fluid.displacePoint(x,y),
    render(pointer,strength,energy=0,delta=1/60,time,visual={}){
      if(disposed)return fallback;
      fluid.step(pointer,strength,delta,time);const state=fluid.getState();
      const values=fluid.density;
      const fillLine=radius*(1-2*(visual.progress??1)),thinkingMix=visual.thinking||0;
      for(let i=0;i<values.length;i++){const y=(Math.floor(i/fluid.resolution)/fluid.resolution-.5)*BOUNDS*2;const fill=Math.max(0,Math.min(1,(y-fillLine+1.2)/2.4));image.data[i*4+3]=Math.round(values[i]*255*(1-thinkingMix+thinkingMix*fill));}
      gridCtx.putImageData(image,0,0);
      ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,SIZE,SIZE);
      ctx.setTransform(2,0,0,2,BOUNDS*2,BOUNDS*2);
      ctx.save();ctx.beginPath();ctx.rect(-BOUNDS,-BOUNDS,BOUNDS*2,BOUNDS*2);
      ctx.arc(0,0,radius-.8,0,TAU,true);ctx.clip('evenodd');
      const listening=Math.max(0,Math.min(1,visual.listening||0));
      const thinking=Math.max(0,Math.min(1,visual.thinking||0));
      const listenWave=.5+.5*Math.sin(state.time*3.2);
      const intensity=1+listening*(.12+.24*listenWave)+thinking*.14+Math.max(0,Math.min(1,energy))*.09;
      const lightGradient=(low,high,color='255,255,255',reach=radius+12)=>{
        const direction=-2.35;
        const dx=Math.cos(direction)*reach,dy=Math.sin(direction)*reach;
        const gradient=ctx.createLinearGradient(-dx,-dy,dx,dy);
        for(const t of [0,.15,.35,.55,.75,1]) {
          const brightness=t**4.5;
          gradient.addColorStop(t,`rgba(${color},${Math.min(1,low+(high-low)*brightness)})`);
        }
        return gradient;
      };
      // Primary remains sharp; separated graphite supports reveal the white light.
      contour(3.8,state.time);ctx.strokeStyle=lightGradient(.018,.598,'56,63,67');ctx.lineWidth=1.80;
      ctx.shadowColor='rgba(43,65,97,.07)';ctx.shadowBlur=1.2;ctx.stroke();
      contour(1.55,state.time);ctx.strokeStyle=lightGradient(.020,.135*intensity);ctx.lineWidth=2.55;
      ctx.shadowColor='rgba(255,255,255,.13)';ctx.shadowBlur=1.9;ctx.stroke();
      contour(1.55,state.time);ctx.strokeStyle=lightGradient(.12,intensity);ctx.lineWidth=1.03;
      ctx.shadowBlur=0;ctx.stroke();
      // Draw each secondary image in angular segments so its edge breaks naturally.
      for(const [offset,width,low,high,dark]of[[5.6,.87,.05,.63,.246],[9.3,.74,.018,.418,.189],[16,.64,.008,.258,.11]]) {
        const graphite=lightGradient(.01,dark,'56,63,67',radius+offset+4);
        const photon=lightGradient(low,high,'255,255,255',radius+offset+4);
        for(let segment=0;segment<36;segment++) {
          const start=segment/36*TAU,end=(segment+1)/36*TAU,angle=(start+end)*.5;
          const arcBreak=.32+.68*(.5+.5*Math.cos(angle*3-state.time*.19))**2;
          if(arcBreak<.005)continue;
          ctx.globalAlpha=arcBreak;
          contour(offset+1.1,state.time,start,end);ctx.strokeStyle=graphite;ctx.lineWidth=1.10;ctx.stroke();
          contour(offset,state.time,start,end);ctx.strokeStyle=photon;ctx.lineWidth=width;ctx.stroke();
        }
        ctx.globalAlpha=1;
      }
      for(const [center,offset,width,alpha,lineWidth]of[
        [state.time*.54+1.3,1.35,.14,.86,.60],
        [state.time*.41-1.9,3.15,.19,.62,.73],
        [state.time*.64+3.6,5.6,.20,.95,.80],
        [state.time*.33-.4,9.3,.24,.82,.73],
        [state.time*.47+2.2,16,.26,.73,.80],
        [state.time*.28-2.7,21.6,.28,.61,.90],
      ]) {
        const bright=.16+.84*(.5+.5*Math.cos(center+2.35))**4.5;
        const from=center-width*1.8,to=center+width*1.8;
        const a=fluid.displacePoint(Math.cos(from)*(radius+offset),Math.sin(from)*(radius+offset));
        const b=fluid.displacePoint(Math.cos(to)*(radius+offset),Math.sin(to)*(radius+offset));
        const streak=ctx.createLinearGradient(a[0],a[1],b[0],b[1]);
        streak.addColorStop(0,'rgba(255,255,255,0)');
        streak.addColorStop(.22,`rgba(255,255,255,${alpha*bright*.37})`);
        streak.addColorStop(.5,`rgba(255,255,255,${alpha*bright})`);
        streak.addColorStop(.78,`rgba(255,255,255,${alpha*bright*.37})`);
        streak.addColorStop(1,'rgba(255,255,255,0)');
        contour(offset,state.time,from,to);ctx.strokeStyle=streak;ctx.lineWidth=lineWidth;
        ctx.shadowColor=`rgba(255,255,255,${alpha*bright*.26})`;ctx.shadowBlur=1.5;ctx.stroke();ctx.shadowBlur=0;
      }
      for(let echo=0;echo<2;echo++) {
        const progress=(state.time*.24+echo*.5)%1;
        const envelope=Math.max(0,Math.sin(progress*Math.PI))**.85;
        if(envelope<.005)continue;
        const offset=15+progress*39;
        for(let segment=0;segment<32;segment++) {
          const start=segment/32*TAU,end=(segment+1)/32*TAU,angle=(start+end)*.5;
          const bright=(.5+.5*Math.cos(angle+2.35))**4.5;
          const mask=(.18+.68*bright)*(.37+.63*(.5+.5*Math.cos(angle*3+echo*1.7))**2)*envelope;
          if(mask<.005)continue;
          contour(offset+1.5,state.time,start,end);ctx.strokeStyle=`rgba(38,57,85,${mask*.39})`;ctx.lineWidth=1.30;ctx.stroke();
          contour(offset,state.time,start,end);ctx.strokeStyle=`rgba(255,255,255,${mask*.64})`;ctx.lineWidth=1.04;ctx.stroke();
        }
      }
      if(Number.isFinite(visual.completeProgress)&&visual.completeProgress>=0) {
        const progress=Math.max(0,Math.min(1,visual.completeProgress));
        const alpha=Math.sin(progress*Math.PI)*(1-progress)**.7*.42;
        ctx.shadowBlur=0;ctx.beginPath();ctx.arc(0,0,radius+5+progress*48,0,TAU);
        ctx.strokeStyle=`rgba(40,60,90,${alpha*.32})`;ctx.lineWidth=1.1;ctx.stroke();
        ctx.beginPath();ctx.arc(0,0,radius+3+progress*48,0,TAU);
        ctx.strokeStyle=`rgba(255,255,255,${alpha})`;ctx.lineWidth=1.25;ctx.stroke();
      }
      ctx.restore();
      ctx.imageSmoothingEnabled=true;ctx.drawImage(grid,-BOUNDS,-BOUNDS,BOUNDS*2,BOUNDS*2);
      return fallback;
    },
    destroy(){disposed=true;fluid.destroy();},
  };
}
