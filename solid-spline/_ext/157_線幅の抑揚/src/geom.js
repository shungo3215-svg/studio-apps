/* ============================================================================
   geom.js — 平面のベジェを曲面へ写す（dim の SurfaceMapper の考え方を移植）

   要点は 1 つだけ:
     **形を点列で持たず、ベジェのまま持って、写した先でもベジェに合わせ直す。**

   点列で持つと、元の分割数以上には滑らかにならない（円を32角形で持てば、
   いくら細かく割っても32角形のまま）。dim は元の曲線を評価しながら、
   写した先で「端点＋接線」を測って3次ベジェを最小二乗フィットし、
   誤差が残るところだけ de Casteljau で割って再帰する。

   参照: 311_dim操作ガイド/app/dim.html
     - fitCubicWithTangents (16130)  接線既知の2点間を3次ベジェで最小二乗フィット
     - mapBezierSegment     (16229)  写して測って、誤差とコーナーで再帰分割
   ========================================================================== */
(function (global) {
  'use strict';

  var K = 0.5522847498307936;          // 円弧を3次ベジェで近似する定数

  /* ---------- セグメント（これがパスの最小単位） ----------
     {type:'L', a:[x,y], b:[x,y]}
     {type:'C', p0,p1,p2,p3:[x,y]}                                          */

  function line(a, b){ return { type:'L', a:a.slice(), b:b.slice() }; }
  function cubic(p0,p1,p2,p3){ return { type:'C', p0:p0.slice(), p1:p1.slice(), p2:p2.slice(), p3:p3.slice() }; }

  function segStart(s){ return s.type==='L' ? s.a : s.p0; }
  function segEnd(s){   return s.type==='L' ? s.b : s.p3; }

  function evalSeg(s, t){
    if (s.type==='L'){
      return [ s.a[0]+(s.b[0]-s.a[0])*t, s.a[1]+(s.b[1]-s.a[1])*t ];
    }
    var u=1-t, w0=u*u*u, w1=3*u*u*t, w2=3*u*t*t, w3=t*t*t;
    return [ w0*s.p0[0]+w1*s.p1[0]+w2*s.p2[0]+w3*s.p3[0],
             w0*s.p0[1]+w1*s.p1[1]+w2*s.p2[1]+w3*s.p3[1] ];
  }

  /* de Casteljau で t の位置で 2 つに割る */
  function splitSeg(s, t){
    if (s.type==='L'){
      var m = evalSeg(s, t);
      return [ line(s.a, m), line(m, s.b) ];
    }
    var p0=s.p0, p1=s.p1, p2=s.p2, p3=s.p3;
    var ab=lerp(p0,p1,t), bc=lerp(p1,p2,t), cd=lerp(p2,p3,t);
    var abc=lerp(ab,bc,t), bcd=lerp(bc,cd,t), m=lerp(abc,bcd,t);
    return [ cubic(p0,ab,abc,m), cubic(m,bcd,cd,p3) ];
  }
  function lerp(a,b,t){ return [ a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t ]; }

  /* ---------- 形を作るヘルパー（すべて [-1,1] の平面で） ---------- */

  function circle(cx, cy, r){
    var k=K*r, s=[];
    s.push(cubic([cx+r,cy], [cx+r,cy+k], [cx+k,cy+r], [cx,cy+r]));
    s.push(cubic([cx,cy+r], [cx-k,cy+r], [cx-r,cy+k], [cx-r,cy]));
    s.push(cubic([cx-r,cy], [cx-r,cy-k], [cx-k,cy-r], [cx,cy-r]));
    s.push(cubic([cx,cy-r], [cx+k,cy-r], [cx+r,cy-k], [cx+r,cy]));
    return s;
  }
  function polyline(pts, closed){
    var s=[]; for (var i=0;i+1<pts.length;i++) s.push(line(pts[i], pts[i+1]));
    if (closed) s.push(line(pts[pts.length-1], pts[0]));
    return s;
  }
  /* 点列を滑らかな3次ベジェ列にする（弦長重み付き Catmull-Rom） */
  function smooth(pts, closed){
    var n=pts.length, s=[], last = closed ? n : n-1;
    for (var i=0;i<last;i++){
      var p0=pts[(i-1+n)%n], p1=pts[i], p2=pts[(i+1)%n], p3=pts[(i+2)%n];
      if (!closed){ if(i===0) p0=p1; if(i>=n-2) p3=p2; }
      var d01=Math.hypot(p1[0]-p0[0],p1[1]-p0[1]);
      var d12=Math.hypot(p2[0]-p1[0],p2[1]-p1[1]);
      var d23=Math.hypot(p3[0]-p2[0],p3[1]-p2[1]);
      var wa=d12/((d01+d12)||1), wb=d12/((d12+d23)||1);
      s.push(cubic(p1,
        [p1[0]+(p2[0]-p0[0])*wa/3, p1[1]+(p2[1]-p0[1])*wa/3],
        [p2[0]-(p3[0]-p1[0])*wb/3, p2[1]-(p3[1]-p1[1])*wb/3], p2));
    }
    return s;
  }

  /* ==========================================================================
     接線が既知の2点間を3次ベジェでフィットする（dim: fitCubicWithTangents）
     C1 = p0 + alpha*tan0 / C2 = p3 - beta*tan3 とおき、
     t=1/3, 2/3 の実測点 v1, v2 に合わせて alpha, beta を最小二乗で解く。
     ========================================================================== */
  function fitCubic(p0, p3, tan0, tan3, v1, v2){
    function basis(t){ var m=1-t; return [m*m*m, 3*m*m*t, 3*m*t*t, t*t*t]; }
    var aa=0, ab=0, bb=0, ar=0, br=0;
    [[1/3, v1], [2/3, v2]].forEach(function(e){
      var b=basis(e[0]), V=e[1];
      var rx = V[0] - (b[0]+b[1])*p0[0] - (b[2]+b[3])*p3[0];
      var ry = V[1] - (b[0]+b[1])*p0[1] - (b[2]+b[3])*p3[1];
      var ax = tan0[0]*b[1], ay = tan0[1]*b[1];
      var bx = -tan3[0]*b[2], by = -tan3[1]*b[2];
      aa += ax*ax+ay*ay;  ab += ax*bx+ay*by;  bb += bx*bx+by*by;
      ar += ax*rx+ay*ry;  br += bx*rx+by*ry;
    });
    var det = aa*bb - ab*ab, alpha, beta;
    var chord = Math.hypot(p3[0]-p0[0], p3[1]-p0[1]);
    if (Math.abs(det) > 1e-9){
      alpha = (bb*ar - ab*br)/det;
      beta  = (aa*br - ab*ar)/det;
    } else { alpha = beta = chord/3; }
    // 地平線ぎわで解が暴れて三角のトゲになるのを止める（dim と同じ手当て）
    var maxArm = Math.max(chord*2, 1e-3);
    if (alpha<0 || beta<0 || alpha>maxArm || beta>maxArm){
      alpha = Math.max(0, Math.min(alpha, maxArm));
      beta  = Math.max(0, Math.min(beta,  maxArm));
      if (alpha<=0 && beta<=0){ alpha = chord/3; beta = chord/3; }
    }
    return [ [p0[0]+tan0[0]*alpha, p0[1]+tan0[1]*alpha],
             [p3[0]-tan3[0]*beta,  p3[1]-tan3[1]*beta] ];
  }

  /* ==========================================================================
     セグメントを写して、写った先のベジェに合わせ直す（dim: mapBezierSegment）
     project(pt) は [x,y] を返すか、写せなければ null。
     戻り値は 写った先のセグメント列（type 'C'）。
     ========================================================================== */
  function mapSegment(seg, project, tol, depth, out){
    depth = depth || 0;
    var p0 = project(evalSeg(seg, 0));
    var p1 = project(evalSeg(seg, 1/3));
    var p2 = project(evalSeg(seg, 2/3));
    var p3 = project(evalSeg(seg, 1));
    if (!p0 || !p1 || !p2 || !p3){
      // どれかが定義域の外。丸ごと捨てると、境界をまたぐ瞬間に線が消える
      // （放射モチーフを横へずらすと実際に出た）。割って有効な側だけ拾う。
      if (!p0 && !p3) return out;                 // 端が両方とも外なら諦める
      if (depth < 7){
        var h = splitSeg(seg, 0.5);
        mapSegment(h[0], project, tol, depth+1, out);
        mapSegment(h[1], project, tol, depth+1, out);
      }
      return out;
    }

    // 端点の接線は「内側への差分」で測る。短いセグメントほど大きく取らないと荒れる
    var segLen = Math.hypot(p3[0]-p0[0], p3[1]-p0[1]);
    var eps = segLen < 3 ? 0.2 : (segLen < 12 ? 0.1 : (segLen < 40 ? 0.05 : 0.01));
    var pe = project(evalSeg(seg, eps)), pf = project(evalSeg(seg, 1-eps));
    var t0 = norm2(pe ? sub2(pe,p0) : sub2(p1,p0));
    var t3 = norm2(pf ? sub2(p3,pf) : sub2(p3,p2));

    var c = fitCubic(p0, p3, t0, t3, p1, p2);
    var fit = { type:'C', p0:p0, p1:c[0], p2:c[1], p3:p3 };

    // 誤差: t=0.5 の実測とフィットの差。0.25/0.75 も見る（片側だけ膨らむ形を拾う）
    var mid = project(evalSeg(seg, 0.5));
    var dist = 0;
    if (mid){
      var f5 = evalSeg(fit, 0.5);
      dist = Math.hypot(mid[0]-f5[0], mid[1]-f5[1]);
      [0.25, 0.75].forEach(function(tq){
        var pr = project(evalSeg(seg, tq)); if (!pr) return;
        var best = Infinity;
        for (var k=0;k<=8;k++){
          var fp = evalSeg(fit, k/8);
          var dd = Math.hypot(pr[0]-fp[0], pr[1]-fp[1]);
          if (dd < best) best = dd;
        }
        if (best > dist) dist = best;
      });
    }

    // コーナー検出: 曲がりが1点に集中していれば、そこは滑らかな弧ではなく折れ目。
    // 誤差が許容内でも割る（丸められた角のまま残るため）。
    var nodes = [p0, pe, p1, mid, p2, pf, p3].filter(Boolean);
    var tAt   = [0, eps, 1/3, 0.5, 2/3, 1-eps, 1].filter(function(_,i){
      return [p0,pe,p1,mid,p2,pf,p3][i]; });
    var maxTurn=0, turn2=0, cornerT=0.5;
    for (var i=1;i+1<nodes.length;i++){
      var u=sub2(nodes[i],nodes[i-1]), w=sub2(nodes[i+1],nodes[i]);
      var lu=Math.hypot(u[0],u[1]), lw=Math.hypot(w[0],w[1]);
      if (lu<1e-9||lw<1e-9) continue;
      var turn=Math.acos(Math.max(-1,Math.min(1,(u[0]*w[0]+u[1]*w[1])/(lu*lw))));
      if (turn>maxTurn){ turn2=maxTurn; maxTurn=turn; cornerT=tAt[i]; }
      else if (turn>turn2) turn2=turn;
    }
    var isCorner = maxTurn > 0.44 && maxTurn > 2.5*turn2 && segLen > 3;

    if (mid && (dist > tol || isCorner) && depth < 8){
      var st = isCorner ? Math.max(0.15, Math.min(0.85, cornerT)) : 0.5;
      var half = splitSeg(seg, st);
      mapSegment(half[0], project, tol, depth+1, out);
      mapSegment(half[1], project, tol, depth+1, out);
      return out;
    }
    out.push(fit);
    return out;
  }

  function sub2(a,b){ return [a[0]-b[0], a[1]-b[1]]; }
  function norm2(a){ var l=Math.hypot(a[0],a[1])||1; return [a[0]/l, a[1]/l]; }

  /* ---------- セグメント列 → path の d 文字列 ---------- */
  function toD(segs, closed){
    if (!segs.length) return '';
    var f=function(p){ return p[0].toFixed(2)+' '+p[1].toFixed(2); };
    var d='M'+f(segStart(segs[0]));
    for (var i=0;i<segs.length;i++){
      var s=segs[i];
      if (s.type==='L') d += 'L'+f(s.b);
      else d += 'C'+f(s.p1)+' '+f(s.p2)+' '+f(s.p3);
    }
    return d + (closed ? 'Z' : '');
  }

  global.Geom = {
    K:K, line:line, cubic:cubic, circle:circle, polyline:polyline, smooth:smooth,
    segStart:segStart, segEnd:segEnd, evalSeg:evalSeg, splitSeg:splitSeg,
    fitCubic:fitCubic, mapSegment:mapSegment, toD:toD
  };
})(window);
