/* =============================================================
   座標の規則（吸着先の構造）

   やりたいことは「アンカーの座標を規則的な配置にする」こと。
   だから規則は**吸着先そのもの**として持つ。グリッドの目が規則で決まり、
   点はそこへ吸着し、目は画面に描かれる ＝ 何の規則が効いているかが常に見える。

   種類は4つだけ。増やすと何ができるか分からなくなるので絞ってある。
     等間隔     … 一定の数値幅。いちばん普通のグリッド
     等比       … 中心から間隔が比率倍ずつ広がる
     フィボナッチ … 間隔が 1,1,2,3,5,8… の比で広がる
     放射       … 中心から等角の直線と、等間隔の同心円

   DOM に触らない。_test/verify.html が数値で検証する。
   ============================================================= */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.Grid=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';

var PHI = 1.6180339887498949;
/* mm と座標の換算。書き出す SVG は座標1=1px で、Illustrator は 1px を 1pt（72dpi）として開くので
   1mm = 72/25.4 座標（= 1座標 0.3528mm）。グリッドの間隔は mm で持ち、吸着には座標へ換算して渡す */
var MM_PX = 72/25.4;
function mmToPx(mm){ return mm*MM_PX; }
function pxToMm(px){ return px/MM_PX; }
/* 保存された状態から間隔(mm)を取り出す。新しい状態は {mm}、旧い状態は {step}（座標=px）なので換算する。
   読めない値は既定の1mm。 */
function stepMmFrom(o){
  var v;
  if(o && isFinite(+o.mm) && +o.mm>0) return +o.mm;
  if(o && isFinite(+o.step) && +o.step>0){ v = pxToMm(+o.step); return Math.round(v*100)/100; }
  return 1;
}
var MAX = 400;                            /* 1方向の目の本数の上限（暴走よけ） */

var KINDS = [
  {id:'even', label:'等間隔', desc:'一定の数値幅'},
  {id:'geom', label:'等比',   desc:'中心から間隔が比率倍ずつ広がる'},
  {id:'fib',  label:'フィボナッチ', desc:'間隔が 1,1,2,3,5,8… の比'},
  {id:'polar',label:'放射',   desc:'中心から等角の直線と同心円'}
];

/* 中心から片側へ並ぶ「目の位置」。0 から始めて limit を超えるまで。 */
function offsets(kind, step, ratio, limit){
  var out = [0], v = 0, d = step, i;
  if(!(step>0)) return out;
  if(kind==='even'){
    for(i=1; i*step<=limit && i<=MAX; i++) out.push(i*step);
    return out;
  }
  if(kind==='fib'){
    var a=1, b=1, t;
    for(i=0; i<MAX; i++){
      v += step*a;
      if(v > limit){ out.push(v); break; }
      out.push(v);
      t=a+b; a=b; b=t;
    }
    return out;
  }
  /* geom */
  var r = (ratio>1.0001 ? ratio : 1.618);
  for(i=0; i<MAX; i++){
    v += d;
    out.push(v);
    if(v > limit) break;
    d *= r;
  }
  return out;
}

/* 中心を挟んで両側に広げた、昇順の値の並び */
function axisValues(kind, step, ratio, limit){
  var half = offsets(kind==='polar'?'even':kind, step, ratio, limit);
  var out = [], i;
  for(i=half.length-1;i>=1;i--) out.push(-half[i]);
  for(i=0;i<half.length;i++) out.push(half[i]);
  return out;
}

/* 昇順の配列から一番近い値。二分探索。 */
function nearest(vals, v){
  if(!vals.length) return v;
  var lo=0, hi=vals.length-1;
  if(v<=vals[0]) return vals[0];
  if(v>=vals[hi]) return vals[hi];
  while(hi-lo>1){
    var mid=(lo+hi)>>1;
    if(vals[mid]<=v) lo=mid; else hi=mid;
  }
  return (v-vals[lo] <= vals[hi]-v) ? vals[lo] : vals[hi];
}

/* cfg = {kind, step, ratio, div, cx, cy}
   戻り値は吸着後の座標。規則が分からない設定でも必ず有限の値を返す。 */
function snapPoint(p, cfg){
  var c = cfg||{}, kind = c.kind||'even';
  var step = c.step>0 ? c.step : 20;
  var cx = c.cx||0, cy = c.cy||0;
  var dx = p.x-cx, dy = p.y-cy;

  if(kind==='polar'){
    var div = Math.max(2, Math.min(64, c.div||12));
    var r = Math.hypot(dx,dy);
    if(r < 1e-9) return {x:cx, y:cy};
    var a = Math.atan2(dy,dx);
    var q = 6.283185307179586/div;
    a = Math.round(a/q)*q;
    r = Math.round(r/step)*step;
    return {x: cx + Math.cos(a)*r, y: cy + Math.sin(a)*r};
  }
  var lim = Math.max(Math.abs(dx), Math.abs(dy)) + step*2;
  var vals = axisValues(kind, step, c.ratio, lim);
  return {x: cx + nearest(vals, dx), y: cy + nearest(vals, dy)};
}

/* 画面に描くための目の位置。
   box は世界座標の可視範囲 {x0,y0,x1,y1}。
   戻り値 {v:[x…], h:[y…]} または放射なら {rays:[角度…], rings:[半径…]} */
function guides(cfg, box){
  var c = cfg||{}, kind = c.kind||'even';
  var step = c.step>0 ? c.step : 20;
  var cx = c.cx||0, cy = c.cy||0;
  if(kind==='polar'){
    var div = Math.max(2, Math.min(64, c.div||12));
    var far = Math.max(
      Math.hypot(box.x0-cx, box.y0-cy), Math.hypot(box.x1-cx, box.y0-cy),
      Math.hypot(box.x0-cx, box.y1-cy), Math.hypot(box.x1-cx, box.y1-cy));
    var rays = [], rings = [], i;
    for(i=0;i<div;i++) rays.push(i*6.283185307179586/div);
    for(i=1; i*step<=far && i<=MAX; i++) rings.push(i*step);
    return {rays:rays, rings:rings, cx:cx, cy:cy};
  }
  var limX = Math.max(Math.abs(box.x0-cx), Math.abs(box.x1-cx));
  var limY = Math.max(Math.abs(box.y0-cy), Math.abs(box.y1-cy));
  var lim = Math.max(limX, limY);
  var vals = axisValues(kind, step, c.ratio, lim);
  var v = [], h = [];
  for(var k=0;k<vals.length;k++){
    var X = cx+vals[k], Y = cy+vals[k];
    if(X>=box.x0 && X<=box.x1) v.push(X);
    if(Y>=box.y0 && Y<=box.y1) h.push(Y);
  }
  return {v:v, h:h, cx:cx, cy:cy};
}

/* 点の集まりの重心。中心を「選択に合わせる」ときに使う */
function centroid(pts){
  if(!pts.length) return {x:0,y:0};
  var x=0,y=0,i;
  for(i=0;i<pts.length;i++){ x+=pts[i].x; y+=pts[i].y; }
  return {x:x/pts.length, y:y/pts.length};
}

/* 中心(cx,cy)から距離 maxDist 以内にある「目の交点」を {x,y} の配列で返す。
   even/geom/fib は axisValues（既存の目の値）の縦×横の全組み合わせのうち
   距離内のものを拾う。polar は中心1点＋各リング半径×各方向の組み合わせ。
   すべて snapPoint の不動点になる値そのものから作るので、吸着の不変条件が
   自動的に満たされる（別ロジックで座標を作って後から確認する、という順序にしない）。 */
function intersections(cfg, maxDist){
  var c = cfg||{}, kind = c.kind||'even';
  var step = c.step>0 ? c.step : 20;
  var cx = c.cx||0, cy = c.cy||0;
  var md = (maxDist>0) ? maxDist : 0;
  var out = [], i, j;

  if(kind==='polar'){
    var div = Math.max(2, Math.min(64, c.div||12));
    out.push({x:cx, y:cy});                    /* 中心は1回だけ */
    var rings = [];
    for(i=1; i*step<=md && i<=MAX; i++) rings.push(i*step);
    var q = 6.283185307179586/div, a;
    for(i=0;i<rings.length;i++){
      for(j=0;j<div;j++){
        a = j*q;
        out.push({x: cx+Math.cos(a)*rings[i], y: cy+Math.sin(a)*rings[i]});
      }
    }
    return out;
  }

  /* even / geom / fib: 目の値は axisValues が中心対称に作ってくれている。
     limit は「距離 md 以内を覆うのに十分な範囲」を渡せばよい（md そのものでよい）。 */
  var vals = axisValues(kind, step, c.ratio, md);
  var md2 = md*md;
  for(i=0;i<vals.length;i++){
    var dx = vals[i];
    if(Math.abs(dx) > md) continue;             /* 早期に落とす（候補の暴走よけ） */
    for(j=0;j<vals.length;j++){
      var dy = vals[j];
      if(dx*dx+dy*dy <= md2) out.push({x:cx+dx, y:cy+dy});
    }
  }
  return out;
}

/* cands から n 個を重複なく選ぶ。cands.length<=n ならコピーを返す。
   rand は [0,1) を返す関数。Fisher-Yates で先頭から並べ替え、先頭 n 個を切り出す
   （毎回同じ rand の列を渡せば同じ結果になる＝決定的）。元配列は変更しない。 */
function pickPoints(cands, n, rand){
  var arr = cands.slice(), i, j, t;
  if(arr.length <= n) return arr;
  for(i=arr.length-1; i>0; i--){
    j = Math.floor(rand()*(i+1));
    if(j>i) j=i; if(j<0) j=0;                   /* rand が万一 [0,1) を外れても壊れない */
    t=arr[i]; arr[i]=arr[j]; arr[j]=t;
  }
  return arr.slice(0, n);
}

/* pts を並べ替えた新しい配列を返す（元配列・要素は変更しない）。
   'angle'  : 重心まわりの偏角で昇順（自己交差しにくい閉じた形になる）
   'near'   : rand で選んだ始点から貪欲に最近傍を辿る
   'random' : Fisher-Yates シャッフル */
function orderPoints(pts, rule, rand){
  var i;
  if(rule==='angle'){
    var c = centroid(pts);
    var withAngle = pts.map(function(p){
      return {p:p, a:Math.atan2(p.y-c.y, p.x-c.x)};
    });
    withAngle.sort(function(u,v){ return u.a-v.a; });
    return withAngle.map(function(w){ return w.p; });
  }
  if(rule==='near'){
    var pool = pts.slice();
    if(!pool.length) return [];
    var startIdx = Math.floor((rand?rand():0) * pool.length);
    if(startIdx>=pool.length) startIdx=pool.length-1;
    if(startIdx<0) startIdx=0;
    var out = [pool.splice(startIdx,1)[0]];
    while(pool.length){
      var last = out[out.length-1], bi=0, bd=Infinity;
      for(i=0;i<pool.length;i++){
        var dx=pool[i].x-last.x, dy=pool[i].y-last.y, d=dx*dx+dy*dy;
        if(d<bd){ bd=d; bi=i; }
      }
      out.push(pool.splice(bi,1)[0]);
    }
    return out;
  }
  /* random: Fisher-Yates シャッフル */
  var arr = pts.slice(), j, t;
  for(i=arr.length-1; i>0; i--){
    j = Math.floor((rand?rand():Math.random())*(i+1));
    if(j>i) j=i; if(j<0) j=0;
    t=arr[i]; arr[i]=arr[j]; arr[j]=t;
  }
  return arr;
}

/* v を数値化する。欠けている値や NaN は既定値 d にフォールバックし、
   NaN を後段に混入させない（regularPoints / starOrder の下ごしらえ用）。 */
function num(v, d){ v = +v; return isFinite(v) ? v : d; }

/* アンカーポイントの規則的な配置。座標は2桁に丸める。
   spec = {shape:'circle'|'double'|'line', n, r, r2, step, cx, cy}
   circle: n点を等角に。角度は -90°（真上）から時計回りに i*360/n、半径 r*step
   double: n点を等角に置き、半径を交互に r*step（偶数番）と r2*step（奇数番）にする
           ＝古典的な星形の作り方
   line  : n点を水平一列に。x = cx + (i-(n-1)/2)*r*step、y = cy
   n<1 や step<=0 でも空配列か有限座標を返し、決して例外を投げない */
function regularPoints(spec){
  var s = spec||{}, shape = s.shape;
  var n = Math.floor(num(s.n,0)); if(n<0) n=0;
  var r = num(s.r,0), r2 = num(s.r2,r), step = num(s.step,0);
  var cx = num(s.cx,0), cy = num(s.cy,0);
  var out = [], i;
  function rd(v){ return Math.round(v*100)/100; }

  if(shape==='circle' || shape==='double'){
    for(i=0;i<n;i++){
      var a = -Math.PI/2 + i*(2*Math.PI/n);
      var rad = (shape==='double' && (i%2===1)) ? r2*step : r*step;
      out.push({x: rd(cx+Math.cos(a)*rad), y: rd(cy+Math.sin(a)*rad)});
    }
    return out;
  }
  if(shape==='line'){
    for(i=0;i<n;i++) out.push({x: rd(cx+(i-(n-1)/2)*r*step), y: rd(cy)});
    return out;
  }
  return out;                                 /* 未知の shape は空配列 */
}

/* 星型多角形の巡り順。d = gcd(n,k) 本の閉路に分かれる。
   戻り値は閉路の配列：d個の配列で、j番目は [j, (j+k)%n, (j+2k)%n, ...]（長さ n/d）。
   例: n=5,k=2 → [[0,2,4,1,3]]（五芒星）／ n=6,k=2 → [[0,2,4],[1,3,5]]（六芒星＝三角形2つ）
   k は 1..n-1 に丸める（k%n が 0 なら 1 とする）。全インデックスがちょうど1回ずつ現れる */
function starOrder(n, k){
  n = Math.floor(num(n,0));
  if(n<1) return [];
  var kf = Math.floor(num(k,1));
  var kk = ((kf%n)+n)%n;
  if(kk===0) kk=1;
  var used=[], out=[], j, idx, cycle;
  for(j=0;j<n;j++) used.push(false);
  for(j=0;j<n;j++){
    if(used[j]) continue;
    cycle = [];
    idx = j;
    while(!used[idx]){
      used[idx]=true;
      cycle.push(idx);
      idx = (idx+kk)%n;
    }
    out.push(cycle);
  }
  return out;
}

return {MM_PX:MM_PX, mmToPx:mmToPx, pxToMm:pxToMm, stepMmFrom:stepMmFrom, kinds:KINDS, offsets:offsets, axisValues:axisValues, nearest:nearest,
        snapPoint:snapPoint, guides:guides, centroid:centroid, PHI:PHI,
        intersections:intersections, pickPoints:pickPoints, orderPoints:orderPoints,
        regularPoints:regularPoints, starOrder:starOrder};
});
