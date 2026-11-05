/* =============================================================
   点どうしの関係の規則（アンカー間の間隔・角度）

   grid.js は「点を座標系に載せる」規則（吸着先そのもの）を持つ。
   こちらは向きが逆で、**点と点の関係**に規則を作る。既存のアンカー列を、
   関係の規則（弧長方向の割合／角度の刻み／折れ角の均一さ）を満たす
   位置へ動かす。吸着先を新しく作るのではなく、今あるアンカーの並びを
   規則に合わせて動かす、という点が grid.js との違い。

   DOM に触らない。_test/verify.html が数値で検証する。
   元の配列・要素は変更しない（呼び出し側の状態を勝手に書き換えない）。
   座標は丸めない（丸めは呼び出し側の仕事）。
   ============================================================= */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.Rules=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';

/* v を数値化する。欠けている値や NaN は既定値 d にフォールバックする
   （grid.js の num と同じ考え方。例外を投げず有限の値だけを扱う）。 */
function num(v, d){ v = +v; return isFinite(v) ? v : d; }

function degToRad(d){ return d*Math.PI/180; }

/* 角度差を (-π, π] に畳み込む。atan2(sin,cos) は while ループより頑丈
   （差がどれだけ大きくても1回で畳める）。 */
function wrapPI(d){ return Math.atan2(Math.sin(d), Math.cos(d)); }

function copyPts(pts){
  var out=[], i;
  for(i=0;i<pts.length;i++) out.push({x:pts[i].x, y:pts[i].y});
  return out;
}

/* ---------- 1. 弧長方向の置き場所 ---------- */

/* m個の区間の「生の間隔」（正規化前）。
   even: 全部1
   geom: 1, ratio, ratio^2, … （オーバーフローしたら0にして以降も有限に保つ）
   alt : 1, ratio, 1, ratio, …
   未知の mode は even 扱い（grid.js の「未知の種類でも有限を返す」に合わせる） */
function rawGaps(m, mode, ratio){
  var out=[], i, r=num(ratio,1), g;
  if(mode==='geom'){
    g=1;
    for(i=0;i<m;i++){ out.push(isFinite(g)?g:0); g=g*r; }
    return out;
  }
  if(mode==='alt'){
    for(i=0;i<m;i++) out.push(i%2===0 ? 1 : r);
    return out;
  }
  for(i=0;i<m;i++) out.push(1);              /* even（既定） */
  return out;
}

/* 弧長方向の「置き場所」を 0..1 の割合の列で返す。n<2 や ratio<=0 でも
   例外を投げない。open は末尾を厳密に1にする（浮動小数の丸め対策）。
   closed は最後の区間（末尾→先頭の戻り）を出力に含めないので末尾<1になる。 */
function spacingFractions(n, closed, mode, ratio){
  n = Math.floor(num(n,0));
  if(n<0) n=0;
  if(n===0) return [];
  if(n===1) return [0];

  var m = closed ? n : (n-1);                 /* 区間の本数 */
  var gaps = rawGaps(m, mode, ratio), i;
  var S=0;
  for(i=0;i<m;i++) S+=gaps[i];
  if(!(Math.abs(S)>1e-12)){                   /* 合計がほぼ0＝正規化できない → 等間隔へ逃げる */
    for(i=0;i<m;i++) gaps[i]=1;
    S=m;
  }
  for(i=0;i<m;i++) gaps[i]=gaps[i]/S;

  var fr=[0], acc=0;
  for(i=0;i<n-1;i++){ acc+=gaps[i]; fr.push(acc); }
  if(!closed) fr[fr.length-1]=1;
  return fr;
}

/* ---------- 2. 弧長の割合 → 曲線上の座標 ---------- */

/* samples（曲線を細かくサンプルしたポリライン）の弧長を積算し、
   fractions の各割合の位置を隣接2点の線形補間で返す。
   samples が0〜1点、全長がほぼ0（縮退）でも有限の座標を返す。 */
function arcPositions(samples, fractions){
  var n = samples ? samples.length : 0, i;
  if(n===0) return fractions.map(function(){ return {x:0,y:0}; });
  if(n===1) return fractions.map(function(){ return {x:samples[0].x, y:samples[0].y}; });

  var cum=[0];
  for(i=1;i<n;i++){
    var dx=samples[i].x-samples[i-1].x, dy=samples[i].y-samples[i-1].y;
    cum.push(cum[i-1]+Math.hypot(dx,dy));
  }
  var total = cum[n-1];

  return fractions.map(function(fr){
    var f = num(fr,0);
    if(f<0) f=0; if(f>1) f=1;
    if(!(total>1e-12)) return {x:samples[0].x, y:samples[0].y};

    var target = f*total;
    if(target<=cum[0]) return {x:samples[0].x, y:samples[0].y};
    if(target>=cum[n-1]) return {x:samples[n-1].x, y:samples[n-1].y};

    var lo=0, hi=n-1;
    while(hi-lo>1){
      var mid=(lo+hi)>>1;
      if(cum[mid]<=target) lo=mid; else hi=mid;
    }
    var segLen = cum[hi]-cum[lo];
    var t = segLen>1e-12 ? (target-cum[lo])/segLen : 0;
    return {
      x: samples[lo].x + (samples[hi].x-samples[lo].x)*t,
      y: samples[lo].y + (samples[hi].y-samples[lo].y)*t
    };
  });
}

/* ---------- 3. 区間長を保った、角度・折れ角の再構築（共通部） ---------- */

/* 区間の単位ベクトル u_i と長さ L_i から、閉じ誤差を吸収する ΔL_i を返す。
   S = Σ L_i u_i（閉じていないぶんのズレ）を、
   ΔL = -Uᵀ (U Uᵀ)⁻¹ S で求める（U は 2×m、列が u_i）。
   これで Σ (L_i+ΔL_i) u_i = 0 になり、角度は一切動かさずに閉じられる。
   U Uᵀ は 2×2 なので逆行列は手で書く。行列式が小さい（全区間ほぼ平行）
   ときは補正できないので null を返す。 */
function closureDelta(L, U){
  var m=L.length, i;
  var Sx=0, Sy=0, a=0, b=0, d=0;
  for(i=0;i<m;i++){
    Sx += L[i]*U[i].x; Sy += L[i]*U[i].y;
    a += U[i].x*U[i].x; b += U[i].x*U[i].y; d += U[i].y*U[i].y;
  }
  var det = a*d - b*b;
  if(Math.abs(det) < 1e-12) return null;
  var inv00=d/det, inv01=-b/det, inv10=-b/det, inv11=a/det;
  var w0 = inv00*Sx + inv01*Sy, w1 = inv10*Sx + inv11*Sy;
  var delta=[];
  for(i=0;i<m;i++) delta.push(-(U[i].x*w0 + U[i].y*w1));
  return delta;
}

/* L（区間長）と U（単位ベクトル）から閉じるための最終長さを求める。
   1回目の補正で負になった区間だけ 0.1*L_i に切り上げ、もう一度だけ
   （＝最大2回）補正をやり直す。2回目も求まらない（det小）ときは
   切り上げた長さをそのまま採用する。 */
function closedLengths(L, U){
  var m=L.length, i;
  var delta = closureDelta(L,U);
  if(delta===null) return null;
  var finalL=[], neg=false;
  for(i=0;i<m;i++){ var v=L[i]+delta[i]; finalL.push(v); if(v<0) neg=true; }
  if(!neg) return finalL;

  var L2=[];
  for(i=0;i<m;i++) L2.push(finalL[i]<0 ? 0.1*L[i] : L[i]);
  var delta2 = closureDelta(L2,U);
  if(delta2===null) return L2;                /* これ以上は補正しない */
  var finalL2=[];
  for(i=0;i<m;i++) finalL2.push(L2[i]+delta2[i]);
  return finalL2;
}

/* 先頭固定＋L・Uの列から点列を再構築する（open/closed共通）。
   出力点数は開: m+1、閉: m（閉じ側の最後の区間は「最後の点→先頭に戻る」
   ぶんなので出力には含めない＝呼び出し側の点の並びと同じ本数になる）。 */
function rebuild(first, L, U, includeLast){
  var out=[{x:first.x, y:first.y}], i, n=L.length;
  var upTo = includeLast ? n : n-1;
  for(i=0;i<upTo;i++){
    var prev=out[out.length-1];
    out.push({x: prev.x+L[i]*U[i].x, y: prev.y+L[i]*U[i].y});
  }
  return out;
}

/* ---------- 4. 角度の丸め（snapAngles） ---------- */

/* 各区間の方向を stepDeg の倍数へ丸める。区間の長さは保つ。
   open  : 先頭の点は動かない。角度は厳密に stepDeg の倍数
   closed: 角度は厳密なまま、長さの最小二乗補正で閉じる。
           行列式が小さすぎて補正できないときは null（呼び出し側が諦められるように） */
function snapAngles(pts, closed, stepDeg){
  var n = pts ? pts.length : 0, i;
  if(n<2) return copyPts(pts||[]);

  var step = num(stepDeg,0);
  var q = step>0 ? degToRad(step) : 0;

  var m = closed ? n : n-1;
  var L=[], U=[];
  for(i=0;i<m;i++){
    var p0=pts[i], p1=pts[(i+1)%n];
    var dx=p1.x-p0.x, dy=p1.y-p0.y;
    var len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx);
    var ra = q>0 ? Math.round(ang/q)*q : ang;
    L.push(len);
    U.push({x:Math.cos(ra), y:Math.sin(ra)});
  }

  if(!closed) return rebuild(pts[0], L, U, true);

  var finalL = closedLengths(L, U);
  if(finalL===null) return null;
  return rebuild(pts[0], finalL, U, false);
}

/* ---------- 5. 折れ角をそろえる（equalTurn） ---------- */

/* 符号付き面積（シューレース公式）。閉じた点列の周り方向の符号を得るのに使う。 */
function signedArea(pts){
  var s=0, n=pts.length, i;
  for(i=0;i<n;i++){
    var p=pts[i], q=pts[(i+1)%n];
    s += p.x*q.y - q.x*p.y;
  }
  return s/2;
}

/* 折れ角（進む方向の変化量）をすべて同じにする。区間の長さは保つ。
   open  : 先頭の点・最初の区間の方向は保ち、以降の折れ角を「元の折れ角の平均」に統一
   closed: 折れ角を ±360/n 度（符号は元の周り方向）に統一し、
           snapAngles と同じ最小二乗の長さ補正で閉じる */
function equalTurn(pts, closed){
  var n = pts ? pts.length : 0, i;
  if(n<2) return copyPts(pts||[]);

  var m = closed ? n : n-1;                    /* 区間の本数 */
  var L=[], ang=[];
  for(i=0;i<m;i++){
    var p0=pts[i], p1=pts[(i+1)%n];
    var dx=p1.x-p0.x, dy=p1.y-p0.y;
    L.push(Math.hypot(dx,dy));
    ang.push(Math.atan2(dy,dx));
  }

  if(!closed){
    var turns=[], sum=0;
    for(i=1;i<m;i++){ var t=wrapPI(ang[i]-ang[i-1]); turns.push(t); sum+=t; }
    var avgTurn = turns.length ? sum/turns.length : 0;

    var dir=[ang[0]];
    for(i=1;i<m;i++) dir.push(dir[i-1]+avgTurn);
    var U=[];
    for(i=0;i<m;i++) U.push({x:Math.cos(dir[i]), y:Math.sin(dir[i])});
    return rebuild(pts[0], L, U, true);
  }

  /* closed: 折れ角を ±360/n に統一。符号は元の周り方向（符号付き面積）から決める。 */
  var area = signedArea(pts);
  var turnStep = (area>=0 ? 1 : -1) * (2*Math.PI/n);

  var dirC=[ang[0]];
  for(i=1;i<m;i++) dirC.push(dirC[0]+i*turnStep);
  var Uc=[];
  for(i=0;i<m;i++) Uc.push({x:Math.cos(dirC[i]), y:Math.sin(dirC[i])});

  var finalL = closedLengths(L, Uc);
  if(finalL===null) return null;
  return rebuild(pts[0], finalL, Uc, false);
}

return {
  spacingFractions: spacingFractions,
  arcPositions: arcPositions,
  snapAngles: snapAngles,
  equalTurn: equalTurn
};
});
