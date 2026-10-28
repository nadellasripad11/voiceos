/* Compact radial material transport. The black source disc is sampled through an
 * inverse displacement map; no white pixels, historical cuts or cursor overlay. */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smooth = value => value * value * (3 - 2 * value);

export function createFluidSimulation({ resolution = 128, bounds = 176, radius = 112 } = {}) {
  const n = clamp(Math.round(Number(resolution) || 128),32,256);
  bounds = Math.max(16,Number(bounds) || 176);
  radius = clamp(Number(radius) || 112,4,bounds*.88);
  const cell = bounds*2/(n-1), density = new Float32Array(n*n);
  const state = { x: 0, y: 0, opening: 0, stretch: 1, dx: 1, dy: 0, time: 0, influence: 48, radius };
  let previousX=0,previousY=0,previousStrength=0,disposed=false,dirty=false;

  function sourcePoint(x,y) {
    if (state.opening<.001) return [x,y,1e3];
    const dx=x-state.x,dy=y-state.y;
    const a=(dx*state.dx+dy*state.dy)/state.stretch;
    const b=(-dx*state.dy+dy*state.dx)*state.stretch;
    const r=Math.hypot(a,b),angle=Math.atan2(b,a);
    const h=state.opening*(1+.014*Math.sin(angle*2+state.time*.9)+.006*Math.sin(angle*3-state.time*.7));
    const h2=h*h,L2=state.influence*state.influence;
    // Forward transport is r²=s²+h² exp(-s²/L²). Its inverse is monotone,
    // with empty space only where no source material can map to the destination.
    let z=Math.max(0,r*r-h2);
    for(let k=0;k<4;k++) {
      const exponential=Math.exp(-z/L2);
      z=Math.max(0,z-(z+h2*exponential-r*r)/(1-h2/L2*exponential));
    }
    const factor=Math.sqrt(z)/Math.max(r,.0001);
    const sa=a*factor*state.stretch,sb=b*factor/state.stretch;
    return [state.x+sa*state.dx-sb*state.dy,state.y+sa*state.dy+sb*state.dx,r-h];
  }

  function signedDistance(x,y) {
    const [sx,sy,horizon]=sourcePoint(x,y);
    return Math.max(Math.hypot(sx,sy)-radius,-horizon);
  }

  function updateDensity() {
    const edge=cell*.46;
    for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
      const sdf=signedDistance(x*cell-bounds,y*cell-bounds);
      const coverage=clamp(.5-sdf/(edge*2),0,1);
      density[y*n+x]=smooth(coverage);
    }
  }

  function step(pointer,strength=0,delta=1/60,motionTime) {
    if(disposed) return;
    const x=Number.isFinite(pointer?.x)?pointer.x:0,y=Number.isFinite(pointer?.y)?pointer.y:0;
    strength=clamp(Number(strength)||0,0,1);
    if(Math.hypot(x,y)>bounds+40) strength=0;
    const dt=clamp(Number(delta)||0,0,.06);
    state.time=Number.isFinite(motionTime)?motionTime:state.time+dt;
    // Position is exact. Only opening size and small motion squash have inertia.
    if(strength>.001) {state.x=x;state.y=y;}
    const target=28*strength;
    const blend=1-Math.exp(-dt*(target>state.opening?72:27));
    state.opening+=(target-state.opening)*blend;
    if(strength<.001 && state.opening<.025) state.opening=0;
    const vx=previousStrength>.001?(x-previousX)/Math.max(dt,.001):0;
    const vy=previousStrength>.001?(y-previousY)/Math.max(dt,.001):0;
    const speed=Math.hypot(vx,vy);
    if(speed>8&&strength>.001) {state.dx=vx/speed;state.dy=vy/speed;}
    const stretch=1+Math.min(speed/3200,.065)*strength;
    state.stretch+=(stretch-state.stretch)*(1-Math.exp(-dt*22));
    previousX=x;previousY=y;previousStrength=strength;
    dirty=true;
  }

  // The forward mapping also moves the exterior horizon for the fallback corona.
  function displacePoint(x,y) {
    const dx=x-state.x,dy=y-state.y;
    const a=(dx*state.dx+dy*state.dy)/state.stretch;
    const b=(-dx*state.dy+dy*state.dx)*state.stretch;
    const r=Math.hypot(a,b),angle=Math.atan2(b,a);
    const h=state.opening*(1+.014*Math.sin(angle*2+state.time*.9)+.006*Math.sin(angle*3-state.time*.7));
    const next=Math.sqrt(r*r+h*h*Math.exp(-r*r/(state.influence*state.influence)));
    const scale=next/Math.max(r,.0001);
    return [state.x+a*scale*state.stretch*state.dx-b*scale/state.stretch*state.dy,
      state.y+a*scale*state.stretch*state.dy+b*scale/state.stretch*state.dx];
  }

  updateDensity();
  return { step,get density(){if(dirty){updateDensity();dirty=false;}return density;},resolution:n,getState:()=>state,signedDistance,displacePoint,destroy(){disposed=true;} };
}
