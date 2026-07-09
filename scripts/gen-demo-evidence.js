/**
 * Demo evidence photo generator — renders photorealistic-style road
 * construction scenes procedurally (fractal-noise terrain, perspective
 * texturing, atmospheric haze, sensor grain) via headless Chromium and
 * writes them to public/demo-evidence/*.jpg.
 *
 * These are SIMULATED demo assets: every image carries a burned-in
 * "SIMULATED DEMO EVIDENCE" watermark, and the app additionally labels
 * demo-fallback submissions in the evidence UI, reports, and ledger
 * provenance. Nothing here touches verification or business logic.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node scripts/gen-demo-evidence.js
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const OUT_DIR = path.join(process.cwd(), "public", "demo-evidence");

const PAGE = `<!doctype html><meta charset="utf-8">
<canvas id="c"></canvas>
<script>
"use strict";
// deterministic PRNG + value noise -------------------------------------
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}}
function makeNoise(seed){
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = [...Array(256).keys()];
  for(let i=255;i>0;i--){const j=Math.floor(rand()*(i+1));[p[i],p[j]]=[p[j],p[i]];}
  for(let i=0;i<512;i++) perm[i]=p[i&255];
  const grid=(x,y)=>perm[(perm[x&255]+y)&255]/255;
  const sm=t=>t*t*(3-2*t);
  function n2(x,y){
    const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    const a=grid(xi,yi),b=grid(xi+1,yi),c=grid(xi,yi+1),d=grid(xi+1,yi+1);
    const u=sm(xf),v=sm(yf);
    return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
  }
  function fbm(x,y,oct=5,lac=2.03,gain=0.52){
    let s=0,a=0.5,f=1,norm=0;
    for(let i=0;i<oct;i++){s+=a*n2(x*f,y*f);norm+=a;a*=gain;f*=lac;}
    return s/norm;
  }
  return { n2, fbm, rand };
}
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
const lerp=(a,b,t)=>a+(b-a)*t;
function mix(c1,c2,t){return [lerp(c1[0],c2[0],t),lerp(c1[1],c2[1],t),lerp(c1[2],c2[2],t)];}

// scene renderer --------------------------------------------------------
// Each scene paints a W×H pixel field: sky band + per-pixel textured
// ground with fake perspective, then scene-specific features, then a
// photographic post pass (haze already applied per-pixel; grain, grade,
// vignette here).
const W=1280,H=853;

function renderScene(cfg){
  const c=document.getElementById("c");
  c.width=W;c.height=H;
  const ctx=c.getContext("2d");
  const N=makeNoise(cfg.seed);
  const HZ=Math.round(H*cfg.horizon);          // horizon row
  const img=ctx.createImageData(W,H);
  const d=img.data;
  const skyTop=cfg.skyTop, skyHz=cfg.skyHz;

  // palettes
  const roadA=cfg.roadA, roadB=cfg.roadB;      // surface tones
  const vegP=cfg.veg;                          // vegetation palette [3]
  const soil=cfg.soil;                         // bare soil

  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      let r,g,b;
      // gently undulating horizon with a hazy treeline band
      const hzOff=(N.fbm(x*0.0012+7,3.3,3)-0.5)*26;
      const hzY=HZ+hzOff;
      // bushy treeline silhouette breaking the horizon
      const treeH=clamp((N.fbm(x*0.0045+21,1.7,4)-0.4)*2.2,0,1)*34
        + clamp((N.fbm(x*0.021+87,4.9,3)-0.5)*2,0,1)*10;
      if(y<hzY-treeH){
        // ---- sky with haze + soft clouds ----
        const t=y/hzY;
        let col=mix(skyTop,skyHz,Math.pow(t,1.25));
        const cl=N.fbm(x*0.0016+40,y*0.004+9,4);
        const clm=clamp((cl-0.55)*3,0,1)*(1-t*0.45)*cfg.cloud;
        col=mix(col,[248,248,246],clm);
        r=col[0];g=col[1];b=col[2];
      }else if(y<hzY){
        // hazy distant canopy
        const leaf=N.fbm(x*0.03+9,y*0.05+3,3);
        let col=mix([84,92,66],[62,72,50],leaf);
        col=mix(col,skyHz,0.55+0.25*(1-(hzY-y)/Math.max(treeH,1)));
        r=col[0];g=col[1];b=col[2];
      }else{
        // ---- ground with fake perspective ----
        const t=Math.max(0.0001,(y-hzY)/(H-hzY)); // 0 horizon -> 1 foreground
        const persp=0.06+t*t*1.7;              // texture scale grows nearer
        // road corridor: center line wanders with noise
        const wander=(N.fbm(0.15,y*0.0016,3)-0.5)*W*cfg.wander;
        const bend=cfg.roadSkew*Math.pow(1-t,1.8)*W;   // gentle alignment curve
        const cx=W*cfg.roadCx+wander*(1-t*0.4)+bend;
        const halfW=(cfg.roadW0+(cfg.roadW1-cfg.roadW0)*t)*W*0.5;
        const dx=(x-cx)/halfW;                 // -1..1 across road
        const edgeN=(N.fbm(x*0.006,y*0.006+77,3)-0.5)*0.55;
        const onRoad=Math.abs(dx)+edgeN*0.3<1;
        // perspective-compressed texture coordinates
        const u=(x-W/2)/(40*persp), v=900/(y-HZ+34);
        const tex=N.fbm(u*0.9+cfg.seed,v*3.1,5);
        const tex2=N.fbm(u*3.7+9,v*11+5,4);    // fine granularity
        if(onRoad){
          let base=mix(roadA,roadB,tex);
          // fine aggregate speckle, stronger in foreground
          const spk=(tex2-0.5)*70*(0.35+t);
          base=[base[0]+spk,base[1]+spk,base[2]+spk];
          // wheel tracks + crown shading
          const tracks=Math.exp(-Math.pow((Math.abs(dx)-0.52)*4.4,2))*26*(0.4+t);
          const crown=(1-Math.abs(dx))*14;
          base=[base[0]-tracks+crown,base[1]-tracks+crown,base[2]-tracks+crown];
          // damp fresh edge
          if(Math.abs(dx)>0.86){base=mix(base,soil,0.5);}
          r=base[0];g=base[1];b=base[2];
        }else{
          // verge: soil strip near road then vegetation
          const off=Math.abs(dx)-1;
          const vegT=clamp(off*2.4-edgeN,0,1);
          // base vegetation mottling in screen space (perspective noise
          // coords smear horizontally near the horizon)
          const patch=N.fbm(x*0.0045+200,y*0.008+31,4);
          let vcol=mix(vegP[0],vegP[1],patch);
          vcol=mix(vcol,vegP[2],clamp((N.fbm(x*0.0021+87,y*0.0042+3,3)-0.42)*2.4,0,1));
          // grass/scrub detail: screen-space clumping (no perspective
          // smear) scaled up toward the foreground
          const gs=N.fbm(x*(0.012+t*0.02),y*(0.02+t*0.03)+cfg.seed,4);
          const gs2=N.fbm(x*0.05+31,y*0.07+11,3);
          const scr=((gs-0.5)*66+(gs2-0.5)*34)*(0.35+t*0.9);
          vcol=[vcol[0]+scr,vcol[1]+scr,vcol[2]+scr*0.8];
          // darker bush clumps
          const bush=N.fbm(x*0.016+301,y*0.021+77,4);
          if(bush>0.6){const dk=(bush-0.6)*230*(0.3+t*0.7);vcol=[vcol[0]-dk,vcol[1]-dk*0.8,vcol[2]-dk];}
          // hazy under-treeline band
          if(t<0.14){const tl=clamp((N.fbm(x*0.008+55,2.1,4)-0.3)*1.8,0,1)*(1-t/0.14);
            vcol=mix(vcol,[70,80,56],tl*0.7);}
          let scol=mix(soil,[soil[0]+22,soil[1]+18,soil[2]+14],tex);
          const sspk=(tex2-0.5)*54*(0.3+t);
          scol=[scol[0]+sspk,scol[1]+sspk,scol[2]+sspk];
          const col=mix(scol,vcol,vegT);
          r=col[0];g=col[1];b=col[2];
        }
        // distance haze toward horizon sky tone
        const haze=Math.pow(1-t,2.6)*cfg.haze;
        r=lerp(r,skyHz[0],haze);g=lerp(g,skyHz[1],haze);b=lerp(b,skyHz[2],haze);
      }
      const i=(y*W+x)*4;
      d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);

  // ---- scene-specific painted features (soft, blurred, textured) ----
  cfg.features(ctx,{W,H,HZ,N});

  // ---- photographic post pass: grade, grain, vignette ----
  const post=ctx.getImageData(0,0,W,H), pd=post.data;
  const gRand=mulberry32(cfg.seed*7+3);
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=(y*W+x)*4;
      let r=pd[i],g=pd[i+1],b=pd[i+2];
      // gentle S-curve + warm grade
      r=255*Math.pow(clamp(r/255,0,1),0.94)*1.015;
      g=255*Math.pow(clamp(g/255,0,1),0.96);
      b=255*Math.pow(clamp(b/255,0,1),1.0)*0.985;
      // sensor grain (luma noise)
      const gr=(gRand()-0.5)*11;
      r+=gr;g+=gr;b+=gr;
      // vignette
      const vx=(x/W-0.5),vy=(y/H-0.5);
      const vig=1-(vx*vx+vy*vy)*0.34;
      r*=vig;g*=vig;b*=vig;
      pd[i]=clamp(r,0,255);pd[i+1]=clamp(g,0,255);pd[i+2]=clamp(b,0,255);
    }
  }
  ctx.putImageData(post,0,0);

  // ---- honest provenance watermark (subtle, burned in) ----
  ctx.font="600 15px -apple-system, Arial, sans-serif";
  const label="SIMULATED DEMO EVIDENCE";
  const tw=ctx.measureText(label).width;
  ctx.fillStyle="rgba(10,14,20,0.42)";
  ctx.fillRect(14,H-40,tw+22,26);
  ctx.fillStyle="rgba(255,255,255,0.8)";
  ctx.fillText(label,25,H-22);
  return c.toDataURL("image/jpeg",0.8);
}

// ---- reusable feature painters ----------------------------------------
function softShadow(ctx,x,y,w,h,a){
  const g=ctx.createRadialGradient(x,y,1,x,y,Math.max(w,h));
  g.addColorStop(0,"rgba(30,24,16,"+a+")");g.addColorStop(1,"rgba(30,24,16,0)");
  ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(x,y,w,h,0,0,7);ctx.fill();
}
function brushPile(ctx,N,x,y,s,seed){
  // clumpy dark scrub pile — many small noise-jittered strokes
  const r=mulberry32(seed);
  softShadow(ctx,x,y+s*0.35,s*1.5,s*0.5,0.35);
  for(let i=0;i<170;i++){
    const a=r()*Math.PI*2, rr=Math.pow(r(),0.6)*s;
    const px=x+Math.cos(a)*rr*1.55, py=y-Math.abs(Math.sin(a))*rr*0.75+s*0.1;
    const tone=40+r()*70, gl=r()<0.3?18:0;
    ctx.strokeStyle="rgba("+(tone+22)+","+(tone+14+gl)+","+(tone*0.8|0)+","+(0.5+r()*0.4)+")";
    ctx.lineWidth=1+r()*2.2;
    ctx.beginPath();ctx.moveTo(px,py);
    ctx.lineTo(px+(r()-0.5)*s*0.5,py-r()*s*0.42);ctx.stroke();
  }
}
function machineSilhouette(ctx,x,y,s,blur,kind){
  // distant construction machine: heavily hazed, desaturated silhouette
  // with a dust plume — atmospheric distance carries the realism, never
  // crisp cartoon geometry.
  ctx.save();
  // dust plume behind the machine
  ctx.filter="blur("+(blur*3+4)+"px)";
  const dg=ctx.createRadialGradient(x-s*0.6,y-s*0.3,1,x-s*0.6,y-s*0.3,s*2.4);
  dg.addColorStop(0,"rgba(214,196,168,0.5)");dg.addColorStop(1,"rgba(214,196,168,0)");
  ctx.fillStyle=dg;ctx.beginPath();ctx.ellipse(x-s*0.7,y-s*0.35,s*2.4,s*1.1,0,0,7);ctx.fill();
  // machine mass
  ctx.filter="blur("+(blur+1.6)+"px)";
  softShadow(ctx,x,y+s*0.28,s*1.1,s*0.3,0.35);
  ctx.fillStyle="rgba(151,128,66,0.78)";
  ctx.beginPath();
  ctx.moveTo(x-s*0.8,y+s*0.1);ctx.lineTo(x-s*0.75,y-s*0.42);ctx.lineTo(x-s*0.2,y-s*0.5);
  ctx.lineTo(x-s*0.14,y-s*0.88);ctx.lineTo(x+s*0.34,y-s*0.86);ctx.lineTo(x+s*0.42,y-s*0.46);
  ctx.lineTo(x+s*0.82,y-s*0.36);ctx.lineTo(x+s*0.85,y+s*0.1);ctx.closePath();ctx.fill();
  ctx.fillStyle="rgba(64,60,54,0.7)";
  ctx.fillRect(x-s*0.8,y-s*0.04,s*1.65,s*0.2);            // undercarriage
  ctx.fillStyle="rgba(38,40,44,0.5)";
  ctx.fillRect(x-s*0.1,y-s*0.84,s*0.26,s*0.3);            // cab glass hint
  if(kind==="grader"){
    ctx.strokeStyle="rgba(128,120,102,0.7)";ctx.lineWidth=s*0.08;
    ctx.beginPath();ctx.moveTo(x-s*1.25,y+s*0.03);ctx.lineTo(x-s*0.4,y-s*0.24);ctx.stroke();
  }
  if(kind==="excavator"){
    ctx.strokeStyle="rgba(146,124,64,0.72)";ctx.lineWidth=s*0.12;
    ctx.beginPath();ctx.moveTo(x+s*0.45,y-s*0.7);ctx.quadraticCurveTo(x+s*1.2,y-s*1.15,x+s*1.45,y-s*0.3);ctx.stroke();
  }
  ctx.restore();
}
function stakes(ctx,N,pts){
  for(const [x,y,h] of pts){
    ctx.strokeStyle="rgba(225,220,208,0.85)";ctx.lineWidth=2.4;
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+1,y-h);ctx.stroke();
    ctx.strokeStyle="rgba(206,74,58,0.9)";ctx.lineWidth=2.6;
    ctx.beginPath();ctx.moveTo(x+1,y-h);ctx.lineTo(x+1,y-h+7);ctx.stroke();
  }
}

// ---- scene definitions -------------------------------------------------
const SCENES={
 "m1-clearing.jpg":{
  seed:11,horizon:0.34,cloud:0.5,haze:0.75,
  skyTop:[168,196,219],skyHz:[229,222,206],
  roadA:[146,102,64],roadB:[172,128,86],       // cleared laterite strip
  soil:[128,92,60],veg:[[108,108,66],[88,96,52],[64,84,46]],
  roadCx:0.46,roadW0:0.05,roadW1:0.92,wander:0.05,roadSkew:0.03,
  features(ctx,{W,H,HZ,N}){
    brushPile(ctx,N,W*0.16,H*0.66,58,5);
    brushPile(ctx,N,W*0.84,H*0.58,44,9);
    brushPile(ctx,N,W*0.75,H*0.82,84,13);
    machineSilhouette(ctx,W*0.55,HZ+H*0.075,26,1.6,"excavator");
    stakes(ctx,N,[[W*0.35,H*0.8,36],[W*0.42,H*0.62,26],[W*0.47,H*0.5,18]]);
  }},
 "m2-drainage.jpg":{
  seed:23,horizon:0.30,cloud:0.35,haze:0.7,
  skyTop:[172,199,222],skyHz:[226,219,204],
  roadA:[126,98,68],roadB:[150,118,82],        // drainage channel bed
  soil:[134,98,64],veg:[[104,104,62],[86,94,52],[66,86,48]],
  roadCx:0.5,roadW0:0.05,roadW1:0.6,wander:0.025,roadSkew:0,
  features(ctx,{W,H,HZ,N}){
    // Composition: the viewer stands in the drainage channel; the new road
    // embankment crosses mid-frame and the culvert headwall is embedded in
    // its toe, carrying the channel beneath the road.
    const r=mulberry32(31);
    const bankTop=H*0.40, bankBot=H*0.62;
    ctx.save();
    ctx.filter="blur(0.5px)";
    // per-pixel earth embankment — noise-mottled fill with ragged edges
    const crest=x=>bankTop+(N.fbm(x*0.006+3,9.1,3)-0.5)*16;
    const toe=x=>bankBot+(N.fbm(x*0.005+17,4.2,3)-0.5)*26+H*0.02;
    for(let x=0;x<W;x+=2){
      const yT=crest(x), yB=toe(x);
      for(let y=yT;y<yB;y+=2){
        const f=(y-yT)/(yB-yT);
        const n=N.fbm(x*0.012,y*0.014+50,4);
        const n2=N.fbm(x*0.05,y*0.06+80,3);
        let rr=168-f*52, gg=134-f*46, bb=94-f*36;
        const m=0.72+n*0.52+(n2-0.5)*0.3;
        rr*=m;gg*=m;bb*=m;
        ctx.fillStyle="rgb("+(rr|0)+","+(gg|0)+","+(bb|0)+")";
        ctx.fillRect(x,y,2,2);
      }
    }
    // erosion rills running down the slope
    ctx.strokeStyle="rgba(84,60,38,0.2)";
    for(let i=0;i<34;i++){
      const sx=r()*W;
      ctx.lineWidth=0.8+r()*2.4;
      ctx.beginPath();ctx.moveTo(sx,crest(sx)+4+r()*10);
      ctx.quadraticCurveTo(sx+(r()-0.5)*22,(bankTop+bankBot)/2,sx+(r()-0.5)*34,toe(sx)-3);
      ctx.stroke();
    }
    // loose spill clumps blending the toe into the channel
    for(let i=0;i<600;i++){
      const px=r()*W, py=toe(px)-6+r()*22;
      const tone=98+r()*74;
      ctx.fillStyle="rgba("+tone+","+((tone*0.74)|0)+","+((tone*0.5)|0)+","+(0.3+r()*0.4)+")";
      const s=1+r()*3.4;
      ctx.fillRect(px,py,s,s*0.8);
    }
    // gravel running surface along the crest of the bank
    for(let x=0;x<W;x+=2){
      const yC=crest(x);
      for(let y=yC-13;y<yC+2;y+=1){
        const n=N.fbm(x*0.04,y*0.05+120,3);
        const tone=150+n*58;
        ctx.fillStyle="rgb("+(tone|0)+","+((tone-8)|0)+","+((tone-22)|0)+")";
        ctx.fillRect(x,y,2,1);
      }
    }
    // shadow line where the slope breaks under the crest
    ctx.strokeStyle="rgba(70,50,32,0.3)";ctx.lineWidth=2.5;
    ctx.beginPath();ctx.moveTo(0,crest(0)+3);
    for(let x=0;x<=W;x+=16)ctx.lineTo(x,crest(x)+3);
    ctx.stroke();
    // concrete headwall set into the toe of the embankment
    const x0=W*0.355,x1=W*0.645,y0=bankTop+H*0.06,y1=bankBot+H*0.075,hh=y1-y0;
    softShadow(ctx,W*0.5,y1+hh*0.12,W*0.2,hh*0.24,0.42);
    const grad=ctx.createLinearGradient(0,y0,0,y1);
    grad.addColorStop(0,"rgb(157,158,150)");grad.addColorStop(0.55,"rgb(138,139,131)");grad.addColorStop(1,"rgb(108,108,100)");
    ctx.fillStyle=grad;ctx.fillRect(x0,y0,x1-x0,hh);
    // wing walls sloping back into the fill
    ctx.fillStyle="rgb(144,145,137)";
    ctx.beginPath();ctx.moveTo(x0,y0+2);ctx.lineTo(x0-W*0.075,y0+hh*0.45);ctx.lineTo(x0-W*0.075,y1);ctx.lineTo(x0,y1);ctx.fill();
    ctx.beginPath();ctx.moveTo(x1,y0+2);ctx.lineTo(x1+W*0.075,y0+hh*0.45);ctx.lineTo(x1+W*0.075,y1);ctx.lineTo(x1,y1);ctx.fill();
    // concrete texture speckle
    for(let i=0;i<2600;i++){
      const px=x0-W*0.075+r()*((x1-x0)+W*0.15),py=y0+r()*hh;
      const t=118+r()*52;
      ctx.fillStyle="rgba("+t+","+t+","+(t-6)+","+(0.14+r()*0.2)+")";
      ctx.fillRect(px,py,1+r()*2.2,1+r()*1.5);
    }
    // formwork joints
    ctx.strokeStyle="rgba(66,68,62,0.28)";ctx.lineWidth=1.1;
    for(const fx of [0.34,0.66]){ctx.beginPath();ctx.moveTo(x0+(x1-x0)*fx,y0+3);ctx.lineTo(x0+(x1-x0)*fx,y1-3);ctx.stroke();}
    ctx.beginPath();ctx.moveTo(x0+2,y0+hh*0.32);ctx.lineTo(x1-2,y0+hh*0.32);ctx.stroke();
    // weathering: rain/dirt streaks bleeding down the face
    for(let i=0;i<44;i++){
      const sx=x0-W*0.06+r()*((x1-x0)+W*0.12), sy=y0+r()*hh*0.3;
      ctx.strokeStyle="rgba(58,56,46,"+(0.05+r()*0.12)+")";
      ctx.lineWidth=0.8+r()*2.6;
      ctx.beginPath();ctx.moveTo(sx,sy);
      ctx.lineTo(sx+(r()-0.5)*5,sy+hh*(0.25+r()*0.55));ctx.stroke();
    }
    // soil splash staining along the base
    ctx.fillStyle="rgba(88,66,44,0.32)";
    ctx.fillRect(x0-W*0.075,y1-hh*0.16,(x1-x0)+W*0.15,hh*0.16);
    // twin barrel openings — slightly elliptical, silted at the invert
    for(const bx of [0.32,0.68]){
      const cxp=x0+(x1-x0)*bx, cy=y0+hh*0.66, rr=hh*0.255;
      const bg=ctx.createRadialGradient(cxp,cy-rr*0.2,rr*0.1,cxp,cy,rr);
      bg.addColorStop(0,"rgb(14,12,9)");bg.addColorStop(0.78,"rgb(36,30,22)");bg.addColorStop(1,"rgb(70,64,54)");
      ctx.fillStyle=bg;ctx.beginPath();ctx.ellipse(cxp,cy,rr,rr*0.94,0,0,7);ctx.fill();
      // dirt-dulled rim, brighter on the sun side only
      ctx.strokeStyle="rgba(188,186,176,0.34)";ctx.lineWidth=2.6;
      ctx.beginPath();ctx.ellipse(cxp,cy,rr+1.5,rr*0.94+1.5,0,Math.PI*1.05,Math.PI*1.95);ctx.stroke();
      ctx.strokeStyle="rgba(96,84,66,0.5)";ctx.lineWidth=3;
      ctx.beginPath();ctx.ellipse(cxp,cy,rr+1.5,rr*0.94+1.5,0,Math.PI*0.08,Math.PI*0.92);ctx.stroke();
      // silt bench in the invert
      ctx.fillStyle="rgba(96,76,52,0.85)";
      ctx.beginPath();ctx.ellipse(cxp,cy+rr*0.72,rr*0.82,rr*0.22,0,0,7);ctx.fill();
      // drip stains under each rim
      for(let i=0;i<10;i++){
        const sx=cxp-rr*0.7+r()*rr*1.4;
        ctx.strokeStyle="rgba(52,44,32,"+(0.08+r()*0.14)+")";
        ctx.lineWidth=1+r()*2;
        ctx.beginPath();ctx.moveTo(sx,cy+rr*0.7);ctx.lineTo(sx+(r()-0.5)*4,y1);ctx.stroke();
      }
      // wet outflow apron in the channel
      ctx.fillStyle="rgba(58,48,36,0.5)";
      ctx.beginPath();ctx.ellipse(cxp,y1+10,rr*1.35,10,0,0,7);ctx.fill();
    }
    // scattered rock riprap at the wall toe
    for(let i=0;i<120;i++){
      const px=x0-W*0.09+r()*((x1-x0)+W*0.18), py=y1-4+r()*20;
      const tone=96+r()*88;
      ctx.fillStyle="rgba("+tone+","+((tone*0.92)|0)+","+((tone*0.78)|0)+","+(0.5+r()*0.4)+")";
      const s=2+r()*6;
      ctx.fillRect(px,py,s,s*0.7);
    }
    ctx.restore();
    machineSilhouette(ctx,W*0.86,bankTop-8,22,2,"excavator");
    stakes(ctx,N,[[W*0.16,H*0.78,34],[W*0.86,H*0.72,28]]);
  }},
 "m3-gravel-a.jpg":{
  seed:37,horizon:0.36,cloud:0.55,haze:0.8,
  skyTop:[164,193,218],skyHz:[227,221,208],
  roadA:[158,148,134],roadB:[184,175,160],     // compacted gravel
  soil:[130,96,62],veg:[[110,108,64],[90,96,54],[70,88,50]],
  roadCx:0.5,roadW0:0.045,roadW1:1.0,wander:0.045,roadSkew:0,
  features(ctx,{W,H,HZ,N}){
    // fresh windrow ridge along one edge
    ctx.save();ctx.filter="blur(0.6px)";
    const r=mulberry32(91);
    for(let i=0;i<900;i++){
      const t=Math.pow(r(),1.4), y=HZ+(H-HZ)*t;
      const x=W*0.5+(W*0.36)* (0.28+t*0.62) + (r()-0.5)*26*t;
      const tone=132+r()*58;
      ctx.fillStyle="rgba("+tone+","+(tone-8)+","+(tone-22)+","+(0.4+r()*0.4)+")";
      const s=(0.6+t*2.6)*(1+r());
      ctx.fillRect(x,y,s,s*0.75);
    }
    ctx.restore();
    stakes(ctx,N,[[W*0.2,H*0.72,34],[W*0.26,H*0.55,24]]);
  }},
 "m3-gravel-b.jpg":{
  seed:53,horizon:0.33,cloud:0.4,haze:0.82,
  skyTop:[170,197,220],skyHz:[229,223,209],
  roadA:[161,151,136],roadB:[186,177,161],
  soil:[132,98,64],veg:[[106,106,62],[88,95,53],[66,86,48]],
  roadCx:0.42,roadW0:0.05,roadW1:1.08,wander:0.06,roadSkew:0.14,
  features(ctx,{W,H,HZ,N}){
    machineSilhouette(ctx,W*0.55,HZ+H*0.13,34,1.4,"grader");
    machineSilhouette(ctx,W*0.47,HZ+H*0.05,12,2.6,"");
  }},
 "m3-gravel-c.jpg":{
  seed:71,horizon:0.35,cloud:0.6,haze:0.78,
  skyTop:[166,194,219],skyHz:[228,221,206],
  roadA:[156,146,132],roadB:[182,173,158],
  soil:[128,95,62],veg:[[109,108,65],[89,96,53],[68,87,49]],
  roadCx:0.53,roadW0:0.05,roadW1:0.98,wander:0.05,roadSkew:-0.04,
  features(ctx,{W,H,HZ,N}){
    // km marker post in right verge
    const x=W*0.815,y=H*0.76;
    softShadow(ctx,x+6,y+6,26,8,0.4);
    ctx.fillStyle="#d9d5c9";ctx.fillRect(x-7,y-92,14,92);
    ctx.fillStyle="#2c2e30";ctx.fillRect(x-7,y-92,14,26);
    ctx.fillStyle="rgba(0,0,0,0.18)";ctx.fillRect(x,y-92,7,92);
    ctx.fillStyle="#e8e5da";ctx.font="700 13px Arial";
    ctx.fillText("12",x-8,y-38);
    stakes(ctx,{},[[W*0.13,H*0.68,30]]);
  }},
 "comm-stockpile.jpg":{
  seed:97,horizon:0.30,cloud:0.45,haze:0.72,
  skyTop:[171,198,221],skyHz:[227,220,205],
  roadA:[150,116,80],roadB:[172,136,96],       // laydown area soil
  soil:[132,98,64],veg:[[106,105,62],[88,94,52],[66,86,48]],
  roadCx:0.5,roadW0:1.3,roadW1:1.6,wander:0,roadSkew:0,
  features(ctx,{W,H,HZ,N}){
    // gravel stockpile heaps in a laydown yard
    const r=mulberry32(55);
    function heap(cx,cy,s){
      // low ground shadow hugging the base
      softShadow(ctx,cx+s*0.28,cy+s*0.07,s*1.2,s*0.22,0.3);
      // solid mound silhouette — full shoulders so the outline never thins
      // into a translucent sliver at the base
      ctx.beginPath();
      ctx.moveTo(cx-s*1.18,cy+s*0.05);
      for(let i=0;i<=26;i++){
        const t=i/26;
        const px=cx-s*1.18+t*2.36*s;
        const e=Math.max(0,1-Math.abs(t-0.5)/0.5);
        const hgt=Math.pow(e,0.55)*s*0.8*(0.94+(r()-0.5)*0.1);
        ctx.lineTo(px,cy+s*0.05-hgt);
      }
      ctx.lineTo(cx+s*1.18,cy+s*0.05);
      ctx.closePath();
      const hg=ctx.createLinearGradient(cx-s,cy-s*0.8,cx+s*0.7,cy+s*0.05);
      hg.addColorStop(0,"rgb(172,161,142)");hg.addColorStop(0.55,"rgb(142,132,114)");hg.addColorStop(1,"rgb(106,97,82)");
      ctx.fillStyle=hg;ctx.fill();
      // contact shadow pinning the pile to the ground
      ctx.strokeStyle="rgba(56,42,28,0.4)";ctx.lineWidth=3;
      ctx.beginPath();ctx.moveTo(cx-s*1.14,cy+s*0.05);ctx.lineTo(cx+s*1.14,cy+s*0.05);ctx.stroke();
      // aggregate texture confined to the mound body
      for(let i=0;i<2600;i++){
        const u=r()*2-1, v=r()*r();
        const px=cx+u*s*1.22*(1-v*0.85);
        const py=cy+s*0.02-v*s*0.76+(r()-0.5)*s*0.05;
        const lit=0.5-u*0.32+v*0.18+(r()-0.5)*0.3;
        const tone=104+lit*88;
        ctx.fillStyle="rgba("+(tone|0)+","+((tone-9)|0)+","+((tone-24)|0)+","+(0.4+r()*0.45)+")";
        const sz=0.8+r()*2.4;
        ctx.fillRect(px,py,sz,sz*0.8);
      }
      // loose spill skirt around the base
      for(let i=0;i<420;i++){
        const u=r()*2-1;
        const px=cx+u*s*(1.28+r()*0.35), py=cy+s*0.04+r()*s*0.12;
        const tone=116+r()*66;
        ctx.fillStyle="rgba("+tone+","+(tone-10)+","+(tone-26)+","+(0.25+r()*0.4)+")";
        ctx.fillRect(px,py,1+r()*2,1+r()*1.4);
      }
    }
    heap(W*0.34,H*0.62,150);
    heap(W*0.68,H*0.66,120);
    heap(W*0.88,H*0.52,64);
    machineSilhouette(ctx,W*0.13,HZ+H*0.1,30,1.5,"");
  }},
};

window.render=(name)=>renderScene(SCENES[name]);
window.sceneNames=Object.keys(SCENES);
</` + `script>`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(PAGE, { waitUntil: "domcontentloaded" });
  const filter = process.argv.slice(2);
  let names = await page.evaluate(() => window.sceneNames);
  if (filter.length) names = names.filter((n) => filter.some((f) => n.includes(f)));
  for (const name of names) {
    const dataUrl = await page.evaluate((n) => window.render(n), name);
    const buf = Buffer.from(dataUrl.split(",")[1], "base64");
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    console.log(`wrote ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
