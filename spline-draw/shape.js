/* =============================================================
   シェイプ形成 — 交わったパスを「面」に分ける
   DOM に触らない。Node でも同じものを読める（_test/verify-shape.js が検証する）。

   115_symmetry/js/geom.js の polyFaces / planarEdges と同じ考え方を、
   このツールの曲線（3次ベジェ区間の配列）に合わせて書き直したもの。
   115 は折れ線どうしの交差で平面グラフを作るが、ここでは
   **曲線どうしの交点をNewton法で精密に求め、曲線のまま切って辺にする**。
   だから面の輪郭が折れ線に落ちず、書き出したSVGが元の曲線と同じ形になる。

   用語
     弧（arc）   交点から交点までの曲線のひとかけら。3次ベジェ区間の列で持つ
     節（node）  弧の端。交点そのもの、または開いた線の端
     面（face）  弧で囲まれた、これ以上分けられない領域

   面の追い方は115と同じ規則：節に着いたら「来た向きの逆」から反時計回りに測って
   一番大きい角の弧へ進む＝いつも一番小さい面を左に見て一周する。
   ただし角度は、折れ線の弦ではなく**曲線の接線**で測る（曲線なので弦だと隣を取り違える）。

   限界（分かっていること）
   - 曲線どうしが一点で接するだけ（交わらず触れる）場合と、長さを持って重なる場合は扱わない
   - 交点は平坦化で当たりを付けてからNewton法で詰めるので、極端に浅い交差は見落としうる
   ============================================================= */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./core.js'));
  else root.ShapeDivide=factory(root.SplineCore);
})(typeof self!=='undefined'?self:this,function(K){
'use strict';

var NODE_EPS  = 1e-3;    /* この距離より近い端どうしは同じ節にする（世界px） */
var PARAM_EPS = 1e-7;    /* 同じパラメータ位置とみなす幅 */
var HIT_EPS   = 1e-6;    /* Newton法で詰めた交点の許容ズレ（世界px） */

/* ---------- 小道具 ---------- */
function rev1(s){ return {p0:{x:s.p1.x,y:s.p1.y}, c1:{x:s.c2.x,y:s.c2.y},
                          c2:{x:s.c1.x,y:s.c1.y}, p1:{x:s.p0.x,y:s.p0.y}}; }
function revGeom(g){ var o=[],i; for(i=g.length-1;i>=0;i--) o.push(rev1(g[i])); return o; }

/* 弧の出だしの向き（接線）。ハンドルが点に重なっている区間もあるので順に落とす */
function startDir(g){
  var s=g[0], dx, dy;
  dx=s.c1.x-s.p0.x; dy=s.c1.y-s.p0.y;
  if(Math.hypot(dx,dy)<1e-9){ dx=s.c2.x-s.p0.x; dy=s.c2.y-s.p0.y; }
  if(Math.hypot(dx,dy)<1e-9){ dx=s.p1.x-s.p0.x; dy=s.p1.y-s.p0.y; }
  if(Math.hypot(dx,dy)<1e-12 && g.length>1){ dx=g[1].p1.x-s.p0.x; dy=g[1].p1.y-s.p0.y; }
  var L=Math.hypot(dx,dy)||1;
  return {x:dx/L, y:dy/L};
}

/* 曲線を折れ線にする。g は「区間番号 + 区間内t」の大域パラメータ */
function flatten(segs, tol, maxN){
  var poly=[], k, i;
  for(k=0;k<segs.length;k++){
    var n = Math.min(maxN||160, Math.max(8, Math.ceil(K.ctrlPolyLen(segs[k])/(tol||0.15))));
    for(i=(k===0?0:1); i<=n; i++){
      var p=K.bezPoint(segs[k], i/n);
      poly.push({g:k+i/n, x:p.x, y:p.y});
    }
  }
  return poly;
}
function polyOf(geom, tol){
  var pts=[], k, i;
  for(k=0;k<geom.length;k++){
    var n=Math.min(48, Math.max(4, Math.ceil(K.ctrlPolyLen(geom[k])/(tol||1))));
    for(i=(k===0?0:1); i<=n; i++){ var p=K.bezPoint(geom[k], i/n); pts.push([p.x,p.y]); }
  }
  return pts;
}
function ringArea(ring){
  var s=0, i;
  for(i=0;i<ring.length;i++){
    var a=ring[i], b=ring[(i+1)%ring.length];
    s += a[0]*b[1] - b[0]*a[1];
  }
  return s/2;
}
/* 奇偶規則の内外判定（rings = 輪の配列） */
function inRings(rings, x, y){
  var inside=false, r, i, j;
  for(r=0;r<rings.length;r++){
    var ring=rings[r];
    for(i=0, j=ring.length-1; i<ring.length; j=i++){
      var xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
      if((yi>y)!==(yj>y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
    }
  }
  return inside;
}

/* 線分どうしの交差。core.js の segLineIntersect と違い、**端点で当たる場合も拾う**。
   円の上に置いたアンカーを線がちょうど通る、といった配置は実際によく起きるので、
   端点を外すと交点を見落として面が見つからない（実測して分かった）。
   平坦化で隣り合う辺どうしは呼び出し側で除いてあるので、共有した頂点を誤検出しない。 */
function xseg(p1,p2,q1,q2){
  var d1x=p2.x-p1.x, d1y=p2.y-p1.y, d2x=q2.x-q1.x, d2y=q2.y-q1.y;
  var den=d1x*d2y-d1y*d2x;
  if(Math.abs(den)<1e-12) return null;
  var ex=q1.x-p1.x, ey=q1.y-p1.y;
  var s=(ex*d2y-ey*d2x)/den, r=(ex*d1y-ey*d1x)/den;
  var E=1e-9;
  if(s<-E || s>1+E || r<-E || r>1+E) return null;
  return {s:Math.min(1,Math.max(0,s)), r:Math.min(1,Math.max(0,r))};
}
/* 大域パラメータ g の位置の座標 */
function ptAt(segs, g){
  var i=Math.floor(g), t=g-i;
  if(i>=segs.length){ i=segs.length-1; t=1; }
  return K.bezPoint(segs[i], t);
}

/* 2本の曲線の交点をNewton法で詰める。ga/gb は平坦化で当たりを付けた大域パラメータ */
function refineCross(sa, sb, ga, gb){
  var ia=Math.floor(ga), ta=ga-ia, ib=Math.floor(gb), tb=gb-ib, it;
  if(ia>=sa.length){ ia=sa.length-1; ta=1; }
  if(ib>=sb.length){ ib=sb.length-1; tb=1; }
  var A=sa[ia], B=sb[ib], pa, pb, d=Infinity;
  for(it=0; it<16; it++){
    pa=K.bezPoint(A,ta); pb=K.bezPoint(B,tb);
    var fx=pa.x-pb.x, fy=pa.y-pb.y;
    d=Math.hypot(fx,fy);
    if(d<1e-12) break;
    var da=K.bezDeriv1(A,ta), db=K.bezDeriv1(B,tb);
    var det = -da.x*db.y + db.x*da.y;
    if(Math.abs(det)<1e-14) break;
    var dt = ( fx*db.y - db.x*fy)/det;
    var du = (-da.x*fy + fx*da.y)/det;
    var na=Math.max(0,Math.min(1, ta+dt)), nb=Math.max(0,Math.min(1, tb+du));
    if(Math.abs(na-ta)<1e-13 && Math.abs(nb-tb)<1e-13){ ta=na; tb=nb; break; }
    ta=na; tb=nb;
  }
  pa=K.bezPoint(A,ta); pb=K.bezPoint(B,tb);
  d=Math.hypot(pa.x-pb.x, pa.y-pb.y);
  return {ga:ia+ta, gb:ib+tb, x:(pa.x+pb.x)/2, y:(pa.y+pb.y)/2, d:d};
}

/* 大域パラメータ u..v の部分曲線。閉じたパスの巻き戻り（v>L）にも対応する */
function cut(segs, u, v, L){
  if(v<=u+1e-12) return [];
  var out;
  if(v<=L+1e-12) out=K.subCurve(segs, u, Math.min(v,L));
  else {
    out=[];
    if(L-u>1e-9) out=out.concat(K.subCurve(segs, u, L));
    var w=v-L;
    if(w>1e-9) out=out.concat(K.subCurve(segs, 0, w));
  }
  /* 切れ目が区間の境目にぴったり来ると、subCurve は長さ0の区間を1本返す。
     そのまま残すと同じ場所にアンカーが2つできるので落とす */
  return out.filter(function(s){ return K.ctrlPolyLen(s) > 1e-9; });
}

/* =========================================================
   分ける本体
   inputs = [{segs:[3次ベジェ区間...], closed:bool}]
   戻り: {nodes, arcs, faces, strays}
   ========================================================= */
function divide(inputs){
  var paths=[], i, j, k;
  for(i=0;i<(inputs||[]).length;i++){
    var p=inputs[i];
    if(p && p.segs && p.segs.length) paths.push({segs:p.segs, closed:!!p.closed, cuts:[]});
  }
  if(!paths.length) return {nodes:[], arcs:[], faces:[], strays:[]};

  /* ---- 1. 交点を全部見つける ---- */
  var polys = paths.map(function(p){ return flatten(p.segs, 0.15, 160); });
  /* 総当たりは点の数の2乗で効く。辺ごとの外接矩形で先に落とす
     （円12個＝約6000辺で、入れないと0.4秒かかる） */
  var boxes = polys.map(function(P){
    var B=new Float64Array(Math.max(0,(P.length-1))*4), k;
    for(k=0;k+1<P.length;k++){
      B[k*4  ]=Math.min(P[k].x,P[k+1].x); B[k*4+1]=Math.max(P[k].x,P[k+1].x);
      B[k*4+2]=Math.min(P[k].y,P[k+1].y); B[k*4+3]=Math.max(P[k].y,P[k+1].y);
    }
    return B;
  });
  var whole = polys.map(function(P){
    var mnx=Infinity,mxx=-Infinity,mny=Infinity,mxy=-Infinity,k;
    for(k=0;k<P.length;k++){
      if(P[k].x<mnx)mnx=P[k].x; if(P[k].x>mxx)mxx=P[k].x;
      if(P[k].y<mny)mny=P[k].y; if(P[k].y>mxy)mxy=P[k].y;
    }
    return [mnx,mxx,mny,mxy];
  });
  for(i=0;i<paths.length;i++){
    for(j=i;j<paths.length;j++){
      if(i!==j){
        var WA=whole[i], WB=whole[j];
        if(WA[1]<WB[0] || WB[1]<WA[0] || WA[3]<WB[2] || WB[3]<WA[2]) continue;
      }
      var PA=polys[i], PB=polys[j], BA=boxes[i], BB=boxes[j], a, b;
      for(a=0; a+1<PA.length; a++){
        var ax0=BA[a*4], ax1=BA[a*4+1], ay0=BA[a*4+2], ay1=BA[a*4+3];
        var bStart = (i===j) ? a+2 : 0;
        for(b=bStart; b+1<PB.length; b++){
          if(ax1<BB[b*4] || BB[b*4+1]<ax0 || ay1<BB[b*4+2] || BB[b*4+3]<ay0) continue;
          /* 同じパスの中：閉じているときの「最後の辺と最初の辺」は隣どうしなので飛ばす */
          if(i===j && a===0 && b+2>=PB.length && paths[i].closed) continue;
          var hit=xseg(PA[a], PA[a+1], PB[b], PB[b+1]);
          if(!hit) continue;
          var ga = PA[a].g + (PA[a+1].g-PA[a].g)*hit.s;
          var gb = PB[b].g + (PB[b+1].g-PB[b].g)*hit.r;
          var r = refineCross(paths[i].segs, paths[j].segs, ga, gb);
          if(r.d > HIT_EPS) continue;
          paths[i].cuts.push(r.ga);
          paths[j].cuts.push(r.gb);
        }
      }
    }
  }

  /* ---- 2. パスごとに切る位置を決める ---- */
  for(i=0;i<paths.length;i++){
    var P=paths[i], L=P.segs.length;
    var cs=P.cuts.slice();
    if(P.closed) cs=cs.map(function(v){ return (v>L-PARAM_EPS || v<PARAM_EPS) ? 0 : v; });
    cs.sort(function(x,y){return x-y;});
    /* 同じ交点を2回拾うことがあるので間引く。見るのは**曲線に沿った長さ**。
       座標の近さで間引くと、自己交差の2つの位置（同じ点だが曲線上では遠い）を
       ひとつに潰してしまい、輪が見つからなくなる（実測して分かった）。
       パラメータ差だと区間の長さがまちまちで近さを測れないので、長さで見る */
    var uu=[], lastU=null;
    for(k=0;k<cs.length;k++){
      if(lastU!==null){
        var piece=cut(P.segs, lastU, cs[k], L), plen=0;
        for(var pi2=0; pi2<piece.length; pi2++) plen += K.ctrlPolyLen(piece[pi2]);
        if(plen < NODE_EPS*10) continue;
      }
      uu.push(cs[k]); lastU=cs[k];
    }
    if(P.closed){
      /* 節が0個・1個だと弧が自分に戻る輪になり、面の追跡が退化する。
         意味を変えずに切れ目を足して、必ず2つ以上の弧にする */
      if(uu.length===0) uu=[0, L/2];
      else if(uu.length===1) uu=[uu[0], uu[0]+L/2 > L ? uu[0]+L/2-L : uu[0]+L/2].sort(function(x,y){return x-y;});
    } else {
      if(!uu.length || uu[0]>PARAM_EPS) uu.unshift(0);
      if(uu[uu.length-1] < L-PARAM_EPS) uu.push(L);
    }
    P.u = uu;
  }

  /* ---- 3. 弧と節を作る ---- */
  var nodes=[], grid=new Map();
  function nodeOf(x,y){
    var gx=Math.round(x/NODE_EPS), gy=Math.round(y/NODE_EPS), dx, dy;
    for(dx=-1;dx<=1;dx++) for(dy=-1;dy<=1;dy++){
      var cell=grid.get((gx+dx)+','+(gy+dy));
      if(cell) for(var q=0;q<cell.length;q++)
        if(Math.hypot(cell[q].x-x, cell[q].y-y)<NODE_EPS) return cell[q];
    }
    var nd={x:x, y:y, out:[], id:nodes.length};
    var key=gx+','+gy;
    if(!grid.has(key)) grid.set(key, []);
    grid.get(key).push(nd);
    nodes.push(nd);
    return nd;
  }
  var arcs=[], halves=[];
  for(i=0;i<paths.length;i++){
    var Pp=paths[i], Lp=Pp.segs.length, us=Pp.u, m=us.length;
    var pairs=[];
    if(Pp.closed){ for(k=0;k<m;k++) pairs.push([us[k], (k+1<m)? us[k+1] : us[0]+Lp]); }
    else          { for(k=0;k+1<m;k++) pairs.push([us[k], us[k+1]]); }
    for(k=0;k<pairs.length;k++){
      var g=cut(Pp.segs, pairs[k][0], pairs[k][1], Lp);
      if(!g.length) continue;
      /* 継ぎ目のズレを潰す（core.js の fillLoops と同じ理由） */
      for(var gi=1; gi<g.length; gi++)
        g[gi]={p0:{x:g[gi-1].p1.x, y:g[gi-1].p1.y}, c1:g[gi].c1, c2:g[gi].c2, p1:g[gi].p1};
      var A=g[0].p0, B=g[g.length-1].p1;
      /* 潰れた弧だけを捨てる。区間が1本でも、自己交差でできた輪は始点と終点が
         同じ点になる（ちゃんとした弧）ので、長さで見ないと消してしまう */
      var glen=0;
      for(var li=0; li<g.length; li++) glen += K.ctrlPolyLen(g[li]);
      if(glen < NODE_EPS*10) continue;
      var na=nodeOf(A.x,A.y), nb=nodeOf(B.x,B.y);
      var arc={id:arcs.length, path:i, geom:g, rgeom:revGeom(g), a:na, b:nb, dead:false};
      var h1={arc:arc, rev:false, from:na, to:nb, geom:g,        used:false};
      var h2={arc:arc, rev:true,  from:nb, to:na, geom:arc.rgeom, used:false};
      h1.twin=h2; h2.twin=h1;
      h1.dir=startDir(h1.geom); h2.dir=startDir(h2.geom);
      arc.h=[h1,h2];
      na.out.push(h1); nb.out.push(h2);
      arcs.push(arc); halves.push(h1,h2);
    }
  }

  /* ---- 4. 面を囲まない枝を刈る（115と同じ：次数1の節から順に落とす） ---- */
  for(var pass=0; pass<nodes.length+1; pass++){
    var changed=false;
    for(i=0;i<nodes.length;i++){
      var live=nodes[i].out.filter(function(h){ return !h.arc.dead; });
      if(live.length===1){ live[0].arc.dead=true; changed=true; }
    }
    if(!changed) break;
  }

  /* ---- 5. 面を追う ---- */
  function nextAround(e){
    /* e で節 e.to に着いた。「来た向きの逆」＝ e.twin の出だしの向きを基準に、
       反時計回りに測って一番大きい角の弧へ進む＝最小の面を左に見る */
    var cur=e.to, ref=e.twin.dir, pick=null, bestA=-Infinity, back=null, c;
    for(c=0;c<cur.out.length;c++){
      var cand=cur.out[c];
      if(cand.arc.dead) continue;
      var ang=Math.atan2(ref.x*cand.dir.y - ref.y*cand.dir.x,
                         ref.x*cand.dir.x + ref.y*cand.dir.y);
      if(ang<=1e-12) ang += 2*Math.PI;
      if(ang > 2*Math.PI-1e-9){ back=cand; continue; }
      if(ang>bestA){ bestA=ang; pick=cand; }
    }
    return pick || back;
  }
  var loops=[];
  for(i=0;i<halves.length;i++){
    var e0=halves[i];
    if(e0.arc.dead || e0.used) continue;
    var loop=[], e=e0, guard=halves.length+4;
    while(guard-- > 0){
      e.used=true; loop.push(e);
      var nx=nextAround(e);
      if(!nx) break;
      if(nx===e0){ if(loop.length>=1) loops.push(loop); break; }
      if(nx.used) break;
      e=nx;
    }
  }

  /* ---- 6. 面と穴に分ける ---- */
  var cand=[];
  for(i=0;i<loops.length;i++){
    var geo=[], hs=loops[i];
    for(k=0;k<hs.length;k++) geo=geo.concat(hs[k].geom);
    for(var q2=1;q2<geo.length;q2++)
      geo[q2]={p0:{x:geo[q2-1].p1.x, y:geo[q2-1].p1.y}, c1:geo[q2].c1, c2:geo[q2].c2, p1:geo[q2].p1};
    var poly=polyOf(geo, 1);
    var ar=ringArea(poly);
    if(Math.abs(ar)<1e-6) continue;
    cand.push({halves:hs, geom:geo, poly:poly, area:ar});
  }
  var faces=[], holes=[];
  for(i=0;i<cand.length;i++) (cand[i].area>0 ? faces : holes).push(cand[i]);
  var out=faces.map(function(f){
    return {outer:f.geom, outerPoly:f.poly, holes:[], holePolys:[], holeHalves:[],
            halves:f.halves, area:f.area};
  });
  for(i=0;i<holes.length;i++){
    var h=holes[i], rp=repPoint(h.poly), best=-1, bestA=Infinity;
    for(j=0;j<faces.length;j++){
      if(faces[j].area > -h.area && faces[j].area < bestA && inRings([faces[j].poly], rp[0], rp[1])){
        best=j; bestA=faces[j].area;
      }
    }
    if(best>=0){
      out[best].holes.push(h.geom);
      out[best].holePolys.push(h.poly);
      out[best].holeHalves.push(h.halves);
    }
  }
  /* 面ごとの目印（中の1点）と重心。
     edges は「この面を囲んでいる弧」全部＝外周＋穴の輪郭。
     穴は外周と繋がっていない別の輪なので、面の追跡では別の輪として出てくる。
     結合するときはこれを数えないと、穴が消えて塗り潰しになる（実測して分かった） */
  for(i=0;i<out.length;i++){
    out[i].id=i;
    out[i].edges=out[i].halves.concat.apply(out[i].halves, out[i].holeHalves);
    out[i].inside=insidePoint(out[i]);
    /* label（札を置く場所）は要るときだけ測る。面が100を超えると全部測るのが重い */
  }
  var strays=[];
  for(i=0;i<arcs.length;i++) if(arcs[i].dead) strays.push(arcs[i].geom);
  return {nodes:nodes, arcs:arcs, faces:out, strays:strays};
}

/* 輪の内側に確実に入る代表点（第1辺の中点を左法線へ少しずらす） */
function repPoint(poly){
  var a=poly[0], b=poly[1]||poly[0];
  var L=Math.hypot(b[0]-a[0], b[1]-a[1])||1;
  return [(a[0]+b[0])/2 - (b[1]-a[1])/L*1e-3,
          (a[1]+b[1])/2 + (b[0]-a[0])/L*1e-3];
}
/* 面の中に入る点。当たり判定と塗りつぶしの起点に使う */
function insidePoint(f){
  var rings=[f.outerPoly].concat(f.holePolys);
  var p=repPoint(f.outerPoly);
  if(inRings(rings, p[0], p[1])) return p;
  /* 穴に食われたときは走査線で探す */
  var mnx=Infinity, mxx=-Infinity, mny=Infinity, mxy=-Infinity, i;
  for(i=0;i<f.outerPoly.length;i++){
    mnx=Math.min(mnx,f.outerPoly[i][0]); mxx=Math.max(mxx,f.outerPoly[i][0]);
    mny=Math.min(mny,f.outerPoly[i][1]); mxy=Math.max(mxy,f.outerPoly[i][1]);
  }
  for(var gy=1; gy<12; gy++) for(var gx=1; gx<12; gx++){
    var x=mnx+(mxx-mnx)*gx/12, y=mny+(mxy-mny)*gy/12;
    if(inRings(rings,x,y)) return [x,y];
  }
  return p;
}
/* 文字を置く場所。面の中で**輪郭から一番遠い点**を粗い格子で探す。
   印を付けた面・カーソルが乗った面のぶんだけ測って、面に覚えさせる。
   代表点（輪郭のすぐ内側）に置くと札が面からはみ出して、どの面の札か分からない */
function labelPoint(f){
  if(f.label) return f.label;
  var rings=[f.outerPoly].concat(f.holePolys), i, r, k;
  var mnx=Infinity, mxx=-Infinity, mny=Infinity, mxy=-Infinity;
  for(i=0;i<f.outerPoly.length;i++){
    mnx=Math.min(mnx,f.outerPoly[i][0]); mxx=Math.max(mxx,f.outerPoly[i][0]);
    mny=Math.min(mny,f.outerPoly[i][1]); mxy=Math.max(mxy,f.outerPoly[i][1]);
  }
  var best=null, bestD=-1, N=14;
  for(var gy=1; gy<N; gy++) for(var gx=1; gx<N; gx++){
    var x=mnx+(mxx-mnx)*gx/N, y=mny+(mxy-mny)*gy/N;
    if(!inRings(rings,x,y)) continue;
    var d=Infinity;
    for(r=0;r<rings.length;r++){
      var ring=rings[r];
      for(k=0;k<ring.length;k++){
        var a=ring[k], b=ring[(k+1)%ring.length];
        var ex=b[0]-a[0], ey=b[1]-a[1], L2=ex*ex+ey*ey || 1;
        var tt=((x-a[0])*ex+(y-a[1])*ey)/L2;
        tt = tt<0?0:(tt>1?1:tt);
        var dd=Math.hypot(x-(a[0]+tt*ex), y-(a[1]+tt*ey));
        if(dd<d) d=dd;
      }
    }
    if(d>bestD){ bestD=d; best=[x,y]; }
  }
  f.label = best || f.inside || insidePoint(f);
  return f.label;
}

/* 面の当たり判定 */
function faceHit(face, x, y){
  return inRings([face.outerPoly].concat(face.holePolys), x, y);
}
/* 点を含む面のうち一番小さいもの（入れ子のとき内側を取る） */
function pickFace(div, x, y){
  var best=null, i;
  for(i=0;i<div.faces.length;i++){
    var f=div.faces[i];
    if(!faceHit(f,x,y)) continue;
    if(!best || f.area<best.area) best=f;
  }
  return best;
}

/* =========================================================
   結合 — 選んだ面をひとつの形にまとめる
   ========================================================= */
function stitch(list){
  /* list = 使う向きのついた半辺の配列。境界として辻褄が合っている前提で輪に繋ぐ */
  var byNode=new Map(), i;
  for(i=0;i<list.length;i++){
    var h=list[i];
    if(!byNode.has(h.from)) byNode.set(h.from, []);
    byNode.get(h.from).push(h);
  }
  var used=new Set(), loops=[];
  for(i=0;i<list.length;i++){
    if(used.has(list[i])) continue;
    var loop=[], e=list[i], guard=list.length+4;
    while(guard-- > 0){
      used.add(e); loop.push(e);
      var outs=(byNode.get(e.to)||[]).filter(function(h){ return !used.has(h); });
      if(!outs.length) break;
      var ref=e.twin.dir, pick=null, bestA=-Infinity, c;
      for(c=0;c<outs.length;c++){
        var ang=Math.atan2(ref.x*outs[c].dir.y - ref.y*outs[c].dir.x,
                           ref.x*outs[c].dir.x + ref.y*outs[c].dir.y);
        if(ang<=1e-12) ang += 2*Math.PI;
        if(ang>bestA){ bestA=ang; pick=outs[c]; }
      }
      if(!pick) break;
      e=pick;
      if(e===list[i]) break;
    }
    loops.push(loop);
  }
  return loops;
}
function loopGeom(hs){
  var geo=[], k;
  for(k=0;k<hs.length;k++) geo=geo.concat(hs[k].geom);
  for(k=1;k<geo.length;k++)
    geo[k]={p0:{x:geo[k-1].p1.x, y:geo[k-1].p1.y}, c1:geo[k].c1, c2:geo[k].c2, p1:geo[k].p1};
  return geo;
}
/* 面の集まり（隣どうし）を1つの形に。戻り: {outer, holes} の配列 */
function unionFaces(faceList){
  /* 内側になった弧（2つの面が共有している弧）を落とし、残りを繋ぐ */
  var count=new Map(), i, k;
  for(i=0;i<faceList.length;i++) for(k=0;k<faceList[i].edges.length;k++){
    var h=faceList[i].edges[k];
    count.set(h.arc, (count.get(h.arc)||0)+1);
  }
  var border=[];
  for(i=0;i<faceList.length;i++) for(k=0;k<faceList[i].edges.length;k++){
    var h2=faceList[i].edges[k];
    if(count.get(h2.arc)===1) border.push(h2);
  }
  if(!border.length) return [];
  var loops=stitch(border).map(function(hs){
    var geo=loopGeom(hs), poly=polyOf(geo,1);
    return {geom:geo, poly:poly, area:ringArea(poly)};
  }).filter(function(L){ return Math.abs(L.area)>1e-6; });

  var outers=loops.filter(function(L){ return L.area>0; });
  var inner =loops.filter(function(L){ return L.area<0; });
  var res=outers.map(function(L){ return {outer:L.geom, outerPoly:L.poly, holes:[], holePolys:[], area:L.area}; });
  for(i=0;i<inner.length;i++){
    var rp=repPoint(inner[i].poly), best=-1, bestA=Infinity;
    for(k=0;k<outers.length;k++){
      if(outers[k].area > -inner[i].area && outers[k].area < bestA && inRings([outers[k].poly], rp[0], rp[1])){
        best=k; bestA=outers[k].area;
      }
    }
    if(best>=0){ res[best].holes.push(inner[i].geom); res[best].holePolys.push(inner[i].poly); }
  }
  return res;
}
/* 印を付けた面（join）を、隣どうしでまとめてから結合する */
function groupsOf(div, joinIds){
  var set=new Set(joinIds), sel=div.faces.filter(function(f){ return set.has(f.id); });
  var parent=new Map();
  function find(a){ while(parent.get(a)!==a) { parent.set(a, parent.get(parent.get(a))); a=parent.get(a); } return a; }
  sel.forEach(function(f){ parent.set(f,f); });
  var owner=new Map(), i, k;
  for(i=0;i<sel.length;i++) for(k=0;k<sel[i].edges.length;k++){
    var arc=sel[i].edges[k].arc;
    if(owner.has(arc)){
      var a=find(owner.get(arc)), b=find(sel[i]);
      if(a!==b) parent.set(a,b);
    } else owner.set(arc, sel[i]);
  }
  var bucket=new Map();
  sel.forEach(function(f){
    var r=find(f);
    if(!bucket.has(r)) bucket.set(r, []);
    bucket.get(r).push(f);
  });
  return [...bucket.values()];
}

return {
  divide:divide, pickFace:pickFace, faceHit:faceHit,
  unionFaces:unionFaces, groupsOf:groupsOf, labelOf:labelPoint,
  ringArea:ringArea, inRings:inRings, polyOf:polyOf, revGeom:revGeom
};
});
