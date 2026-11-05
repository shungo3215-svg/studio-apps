/* =============================================================
   スプライン描画ツール — 数式の核
   DOM に触らない。Node でも同じものを読める（_test/verify.js が検証する）。

   132_Bスプライン/spline.html L379-532 から流用したもの（buildCurve / findSpan /
   basisFuns / basisVector / evalCurve / derivCurve / spanBreaks / toBeziers / gauss）と、
   このツールのために書いたもの（solveTridiag / solveCyclicTridiag / insertKnot /
   fitOpen / fitClosed）がある。

   このツールの中心にある決めごと：
   **曲線は置いた点を通り、置いた点はそのまま書き出しのアンカーになる。**
   132 の interpCurve は Piegl A9.1 の平均化ノットを使うので、曲線は点を通るが
   ノットが点のパラメータに来ず、5点置いても3点しかアンカーにならない（実測済み）。
   ここではデータ点のパラメータをそのままノットに置く古典的な3次スプライン補間にした。
   制御点は両端条件のぶん2つ増えて n+2 個になる。
   ============================================================= */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.SplineCore=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';

/* ---------- 1. Bスプラインの評価（132 から流用） ---------- */

function buildCurve(P,degree,mode,interior){
  var pts,U,p,i,N;
  if(mode==='closed'){
    var n=P.length;
    p=Math.max(1,Math.min(degree,n-1));
    pts=P.concat(P.slice(0,p));
    var m=pts.length+p+1; U=[];
    for(i=0;i<m;i++) U.push(i/(m-1));
  } else if(mode==='uniform'){
    pts=P.slice();
    p=Math.max(1,Math.min(degree,pts.length-1));
    var m2=pts.length+p+1; U=[];
    for(i=0;i<m2;i++) U.push(i/(m2-1));
  } else {
    pts=P.slice(); N=pts.length;
    p=Math.max(1,Math.min(degree,N-1));
    var nInt=N-p-1, inner;
    if(interior&&interior.length===nInt) inner=interior.slice().sort(function(a,b){return a-b});
    else { inner=[]; for(i=1;i<=nInt;i++) inner.push(i/(nInt+1)); }
    U=[];
    for(i=0;i<=p;i++) U.push(0);
    for(i=0;i<inner.length;i++) U.push(inner[i]);
    for(i=0;i<=p;i++) U.push(1);
  }
  N=pts.length;
  return {pts:pts,U:U,p:p,N:N,u0:U[p],u1:U[N]};
}

function curveOf(pts,U,p){
  return {pts:pts,U:U,p:p,N:pts.length,u0:U[p],u1:U[pts.length]};
}

function findSpan(c,u){
  var U=c.U,N=c.N,p=c.p,k;
  if(u>=U[N]){ k=N-1; while(k>p&&U[k]===U[k+1])k--; return k; }
  if(u<=U[p]){ k=p; while(k<N-1&&U[k]===U[k+1])k++; return k; }
  var lo=p,hi=N,mid=(lo+hi)>>1,g=0;
  while((u<U[mid]||u>=U[mid+1])&&g++<200){
    if(u<U[mid])hi=mid; else lo=mid;
    var nx=(lo+hi)>>1;
    if(nx===mid){ mid=lo; break; }
    mid=nx;
  }
  return mid;
}

function basisFuns(c,span,u){
  var U=c.U,p=c.p,j,r;
  var N=new Array(p+1),L=new Array(p+1),R=new Array(p+1);
  for(j=0;j<=p;j++){N[j]=0;L[j]=0;R[j]=0}
  N[0]=1;
  for(j=1;j<=p;j++){
    L[j]=u-U[span+1-j]; R[j]=U[span+j]-u;
    var s=0;
    for(r=0;r<j;r++){
      var den=R[r+1]+L[j-r], t=den===0?0:N[r]/den;
      N[r]=s+R[r+1]*t; s=L[j-r]*t;
    }
    N[j]=s;
  }
  return N;
}

function basisVector(c,u){
  var out=new Array(c.N),i;
  for(i=0;i<c.N;i++) out[i]=0;
  var sp=findSpan(c,u), Nv=basisFuns(c,sp,u);
  for(var j=0;j<=c.p;j++){ var k=sp-c.p+j; if(k>=0&&k<c.N) out[k]=Nv[j]; }
  return out;
}

function evalCurve(c,u,forced){
  var sp=forced===undefined?findSpan(c,u):forced;
  var Nv=basisFuns(c,sp,u), x=0, y=0;
  for(var j=0;j<=c.p;j++){ var P=c.pts[sp-c.p+j]; x+=Nv[j]*P.x; y+=Nv[j]*P.y; }
  return {x:x,y:y};
}

function derivCurve(c){
  if(c.p<1) return null;
  var U=c.U,p=c.p,pts=c.pts,Q=[],i;
  for(i=0;i<pts.length-1;i++){
    var den=U[i+p+1]-U[i+1], f=den===0?0:p/den;
    Q.push({x:(pts[i+1].x-pts[i].x)*f, y:(pts[i+1].y-pts[i].y)*f});
  }
  var U2=U.slice(1,U.length-1);
  return curveOf(Q,U2,p-1);
}

function spanBreaks(c){
  var b=[];
  for(var i=c.p;i<=c.N;i++){ var v=c.U[i]; if(!b.length||v>b[b.length-1]+1e-9) b.push(v); }
  return b;
}

/* 3次ベジェへの分解。次数3以下は Hermite で厳密（span 中央で span を固定して評価する）。 */
function toBeziers(c,d1){
  if(!d1) d1=derivCurve(c);
  var sub=c.p<=3?1:8, brk=spanBreaks(c), segs=[],s,k;
  for(s=0;s<brk.length-1;s++){
    var a0=brk[s], b0=brk[s+1];
    for(k=0;k<sub;k++){
      var a=a0+(b0-a0)*(k/sub), b=a0+(b0-a0)*((k+1)/sub), h=b-a, mid=(a+b)/2;
      var sc=findSpan(c,mid), sd=findSpan(d1,mid);
      var P0=evalCurve(c,a,sc), P1=evalCurve(c,b,sc);
      var T0=evalCurve(d1,a,sd), T1=evalCurve(d1,b,sd);
      segs.push({p0:P0,c1:{x:P0.x+T0.x*h/3,y:P0.y+T0.y*h/3},
                       c2:{x:P1.x-T1.x*h/3,y:P1.y-T1.y*h/3},p1:P1});
    }
  }
  return segs;
}

/* ---------- 2. ノット挿入（Böhm）— 132 に無かったもの ---------- */

/* 形を変えずに制御点を1つ増やす。ベジェ分解とセグメント分割に使う。 */
function insertKnot(c,u){
  var U=c.U,p=c.p,pts=c.pts,N=c.N,i;
  var k=findSpan(c,u), Q=[];
  for(i=0;i<=k-p;i++) Q.push(pts[i]);
  for(i=k-p+1;i<=k;i++){
    var den=U[i+p]-U[i];
    var a=den===0?0:(u-U[i])/den;
    Q.push({x:(1-a)*pts[i-1].x+a*pts[i].x, y:(1-a)*pts[i-1].y+a*pts[i].y});
  }
  for(i=k;i<N;i++) Q.push(pts[i]);
  var U2=U.slice(0,k+1).concat([u]).concat(U.slice(k+1));
  return curveOf(Q,U2,p);
}

/* ---------- 3. 連立一次方程式 ---------- */

/* 密行列のガウス・ジョルダン。速くないので検証の基準としてだけ使う。 */
function gauss(A,B){
  var n=A.length,m=B[0].length,i,j,k;
  var M=A.map(function(r,ri){return r.slice().concat(B[ri].slice())});
  for(i=0;i<n;i++){
    var piv=i;
    for(j=i+1;j<n;j++) if(Math.abs(M[j][i])>Math.abs(M[piv][i])) piv=j;
    if(Math.abs(M[piv][i])<1e-14) return null;
    var tmp=M[i];M[i]=M[piv];M[piv]=tmp;
    var d=M[i][i];
    for(k=i;k<n+m;k++) M[i][k]/=d;
    for(j=0;j<n;j++){
      if(j===i) continue;
      var f=M[j][i];
      if(f===0) continue;
      for(k=i;k<n+m;k++) M[j][k]-=f*M[i][k];
    }
  }
  return M.map(function(r){return r.slice(n)});
}

/* 帯行列のガウス消去。kl=下の帯幅 / ku=上の帯幅。O(n·kl·ku)。
   部分ピボット交換つき。交換すると上の帯が kl だけ広がるので、走査幅もそのぶん取る。
   （結果が密ソルバと一致することは verify.js が確かめる） */
function solveBanded(rows,d,kl,ku){
  var n=rows.length,i,j,k;
  var A=rows.map(function(r){return r.slice()}), b=d.slice();
  var kw=ku+kl;                                   /* 交換後に埋まりうる上の幅 */
  for(i=0;i<n;i++){
    var last=Math.min(n-1,i+kl), piv=i, m=Math.abs(A[i][i]);
    for(j=i+1;j<=last;j++){ var v=Math.abs(A[j][i]); if(v>m){m=v;piv=j} }
    if(m<1e-14) return null;
    if(piv!==i){ var tr=A[i];A[i]=A[piv];A[piv]=tr; var tb=b[i];b[i]=b[piv];b[piv]=tb; }
    var pv=A[i][i], to=Math.min(n-1,i+kw);
    for(j=i+1;j<=last;j++){
      var f=A[j][i];
      if(f===0) continue;
      f/=pv;
      for(k=i;k<=to;k++) A[j][k]-=f*A[i][k];
      b[j]-=f*b[i];
    }
  }
  var x=new Array(n);
  for(i=n-1;i>=0;i--){
    var s=b[i], hi=Math.min(n-1,i+kw);
    for(k=i+1;k<=hi;k++) s-=A[i][k]*x[k];
    x[i]=s/A[i][i];
  }
  return x;
}

/* 三重対角（Thomas法）。a=下 / b=対角 / c=上。O(n)。 */
function solveTridiag(a,b,c,d){
  var n=b.length,i;
  var cp=new Array(n), dp=new Array(n), x=new Array(n);
  if(Math.abs(b[0])<1e-14) return null;
  cp[0]=c[0]/b[0]; dp[0]=d[0]/b[0];
  for(i=1;i<n;i++){
    var m=b[i]-a[i]*cp[i-1];
    if(Math.abs(m)<1e-14) return null;
    cp[i]=c[i]/m; dp[i]=(d[i]-a[i]*dp[i-1])/m;
  }
  x[n-1]=dp[n-1];
  for(i=n-2;i>=0;i--) x[i]=dp[i]-cp[i]*x[i+1];
  return x;
}

/* 巡回三重対角（Sherman-Morrison）。閉じたパスの周期補間に使う。O(n)。
   隅の a[0]（左下でなく右上）と c[n-1]（左下）が輪をつくる。 */
function solveCyclicTridiag(a,b,c,d){
  var n=b.length,i;
  if(n<3) return null;
  var gamma=-b[0];
  if(Math.abs(gamma)<1e-14) gamma=-1;
  var bb=b.slice();
  bb[0]=b[0]-gamma;
  bb[n-1]=b[n-1]-a[0]*c[n-1]/gamma;
  var y=solveTridiag(a,bb,c,d);
  if(!y) return null;
  var u=new Array(n);
  for(i=0;i<n;i++) u[i]=0;
  u[0]=gamma; u[n-1]=c[n-1];
  var z=solveTridiag(a,bb,c,u);
  if(!z) return null;
  /* v = [1, 0, ..., 0, a0/gamma] */
  var vy=y[0]+a[0]/gamma*y[n-1];
  var vz=z[0]+a[0]/gamma*z[n-1];
  var f=vy/(1+vz);
  var x=new Array(n);
  for(i=0;i<n;i++) x[i]=y[i]-f*z[i];
  return x;
}

/* ---------- 4. 通過点から曲線をつくる ---------- */

/* 弦長パラメータ。0..1 に正規化する。
   closed のときは最後の要素が 1（＝先頭に戻る位置）で、長さ n+1 になる。 */
function chordParams(D,closed){
  var n=D.length, t=[0], tot=0, i;
  var lim=closed?n:n-1;
  for(i=0;i<lim;i++){
    var a=D[i], b=D[(i+1)%n];
    var seg=Math.hypot(b.x-a.x,b.y-a.y);
    tot+=seg>1e-12?seg:1e-12;
    t.push(tot);
  }
  for(i=0;i<t.length;i++) t[i]/=tot;
  return t;
}

/* u における order 階微分の、制御点への線形係数。両端の条件をつくるのに使う。
   order=2 → 自然条件（曲率ゼロ）。order=1 → 接線を指定する条件（ベジェのハンドルを渡すとき）。
   端では p+1 個の基底しか効かないので、範囲を絞って呼ぶ。 */
function dRow(U,p,N,u,order,from,to){
  var row=new Array(N),i,k;
  for(i=0;i<N;i++) row[i]=0;
  for(i=from;i<to;i++){
    var pts=new Array(N);
    for(k=0;k<N;k++) pts[k]={x:k===i?1:0,y:0};
    var c=curveOf(pts,U,p);
    for(k=0;k<order;k++) c=derivCurve(c);
    var uu=Math.min(Math.max(u,c.u0),c.u1);
    row[i]=evalCurve(c,uu).x;
  }
  return row;
}

/* 開いたパス：データ点をすべて通り、データ点がそのままノット＝アンカーになる3次スプライン。
   制御点は n+2 個（両端の条件で2つ増える）。行列は帯行列なので O(n)。

   opts.t0 / opts.t1 に接線ベクトルを渡すと、その端は「接線を指定」の条件になる。
   ベジェ区間と地続きにするための入口で、隣のハンドルをそのまま渡せば折れずに繋がる。
   渡さなければ従来どおり自然条件（曲率ゼロ）。 */
function fitOpen(D,degree,opts){
  var p=degree===undefined?3:degree, n=D.length, i;
  opts=opts||{};
  if(n<2) return null;
  if(n===2){
    /* 2点。接線が指定されていればそれをハンドルにした3次、無ければ直線 */
    var A={x:D[0].x,y:D[0].y}, B={x:D[1].x,y:D[1].y};
    var lin=function(f){return {x:A.x+(B.x-A.x)*f, y:A.y+(B.y-A.y)*f}};
    var c1=opts.t0?{x:A.x+opts.t0.x/3,y:A.y+opts.t0.y/3}:lin(1/3);
    var c2=opts.t1?{x:B.x-opts.t1.x/3,y:B.y-opts.t1.y/3}:lin(2/3);
    return {curve:curveOf([A,c1,c2,B],[0,0,0,0,1,1,1,1],3), t:[0,1]};
  }
  var t=chordParams(D,false);
  /* ノット：両端 p+1 重、内部は t_1..t_{n-2} */
  var U=[];
  for(i=0;i<=p;i++) U.push(t[0]);
  for(i=1;i<=n-2;i++) U.push(t[i]);
  for(i=0;i<=p;i++) U.push(t[n-1]);
  var N=U.length-p-1;                       /* = n+2 */
  var sh={U:U,p:p,N:N};                     /* 基底の評価に pts は要らない */
  var rows=[], bx=[], by=[];
  var put=function(row,x,y){ rows.push(row); bx.push(x); by.push(y) };
  /* 行の並びが肝。t0 の補間行は列0しか持たないので、両端条件より前に置かないと
     対角がゼロになって解けない。両端で同じことをする。 */
  var e0=Math.min(N,p+2), e1=Math.max(0,N-p-2);
  put(basisVector(sh,t[0]), D[0].x, D[0].y);                        /* 0   : t0 を通る */
  if(opts.t0) put(dRow(U,p,N,t[0],1,0,e0), opts.t0.x, opts.t0.y);   /* 1   : 先頭の接線を指定 */
  else        put(dRow(U,p,N,t[0],2,0,e0), 0, 0);                   /*       または曲率ゼロ */
  for(i=1;i<=n-2;i++) put(basisVector(sh,t[i]), D[i].x, D[i].y);    /* 2..n-1 : 中の点 */
  if(opts.t1) put(dRow(U,p,N,t[n-1],1,e1,N), opts.t1.x, opts.t1.y); /* n   : 末尾の接線を指定 */
  else        put(dRow(U,p,N,t[n-1],2,e1,N), 0, 0);                 /*       または曲率ゼロ */
  put(basisVector(sh,t[n-1]), D[n-1].x, D[n-1].y);                  /* n+1 : t_{n-1} を通る */

  var band=p+2;
  var X=solveBanded(rows,bx,band,band), Y=solveBanded(rows,by,band,band);
  if(!X||!Y) return null;
  var pts=[];
  for(i=0;i<N;i++) pts.push({x:X[i],y:Y[i]});
  return {curve:curveOf(pts,U,p), t:t};
}

/* 閉じたパス：周期の3次スプライン。継ぎ目も他の点と同じ扱いになる。
   132 は「先頭点を複製して開曲線として補間する」誤魔化しだったので継ぎ目が滑らかにならない。
   制御点は n 個で、行列は巡回三重対角。 */
function fitClosed(D,degree){
  var p=degree===undefined?3:degree, n=D.length, i, j;
  if(n<3) return null;
  var tt=chordParams(D,true);               /* 長さ n+1、末尾が 1 */
  /* ノットを周期に伸ばす。U[j] = t[j-p]（範囲外は ±1 して巻く） */
  var tv=function(k){
    if(k<0) return tt[k+n]-1;
    if(k>n) return tt[k-n]+1;
    return tt[k];
  };
  var U=[];
  for(j=0;j<=n+2*p;j++) U.push(tv(j-p));
  var N=n+p;                                /* 制御点（末尾 p 個は先頭の複製） */
  var sh={U:U,p:p,N:N}, bx=[], by=[];
  /* 帯の3本だけを直に組む。basisVector で長さ N の配列を n 本つくると O(n²) になり、
     n=400 の閉パスで 93ms かかっていた（実測）。効く基底は p+1 個しかない。 */
  /* 行 i の非ゼロ列は3本つづきだが、行番号とは一定量ずれている（3次だと i, i+1, i+2 で
     真ん中が i+1）。ずれ量を決め打ちすると外れて毎回 密ソルバ（O(n³)）へ落ちる。
     一度それで n=400 が 124ms になったので、実データから検出して整合も確かめる。 */
  var a=new Array(n), b=new Array(n), c=new Array(n), spill=(n<5), off=-1;
  for(i=0;i<n;i++){ a[i]=0;b[i]=0;c[i]=0 }
  for(i=0;i<n&&!spill;i++){
    var u=tt[i], sp=findSpan(sh,u), Nv=basisFuns(sh,sp,u), cols=[], vals=[];
    for(j=0;j<=p;j++){
      var v=Nv[j], idx=sp-p+j;
      if(!v||Math.abs(v)<1e-14||idx<0||idx>=N) continue;
      cols.push(((idx%n)+n)%n); vals.push(v);
    }
    if(cols.length!==3){ spill=true; break; }
    /* 3本のうち、左右の隣も揃っているものが真ん中 */
    var mid=-1;
    for(j=0;j<3;j++){
      if(cols.indexOf((cols[j]-1+n)%n)>=0 && cols.indexOf((cols[j]+1)%n)>=0){ mid=j; break }
    }
    if(mid<0){ spill=true; break; }
    var o=(cols[mid]-i+n)%n;
    if(off<0) off=o; else if(o!==off){ spill=true; break; }
    for(j=0;j<3;j++){
      if(j===mid) b[i]+=vals[j];
      else if(cols[j]===(cols[mid]-1+n)%n) a[i]+=vals[j];
      else c[i]+=vals[j];
    }
  }
  for(i=0;i<n;i++){ bx.push(D[i].x); by.push(D[i].y) }
  var X=null,Y=null;
  if(!spill&&off>=0){
    var xp=solveCyclicTridiag(a,b,c,bx), yp=solveCyclicTridiag(a,b,c,by);
    if(xp&&yp){                             /* ずらした並びを戻す */
      X=new Array(n); Y=new Array(n);
      for(i=0;i<n;i++){ X[(i+off)%n]=xp[i]; Y[(i+off)%n]=yp[i]; }
    }
  }
  if(!X||!Y){                               /* はみ出た場合だけ密で解く（n が小さいときだけ） */
    var rows=[];
    for(i=0;i<n;i++){
      var full=basisVector(sh,tt[i]), row=new Array(n);
      for(j=0;j<n;j++) row[j]=0;
      for(j=0;j<N;j++) if(full[j]!==0) row[((j%n)+n)%n]+=full[j];
      rows.push(row);
    }
    var R=gauss(rows,bx.map(function(v2,k){return [v2,by[k]]}));
    if(!R) return null;
    X=R.map(function(r){return r[0]}); Y=R.map(function(r){return r[1]});
  }
  var base=[];
  for(i=0;i<n;i++) base.push({x:X[i],y:Y[i]});
  var pts=base.concat(base.slice(0,p));
  return {curve:curveOf(pts,U,p), t:tt};
}

/* フリーハンドの軌跡をアンカー列に要約する（鉛筆ツールの中身）。
   両端だけから始めて、通る曲線を当てて、軌跡から一番外れた場所にアンカーを
   足す——を許容誤差に収まるまで繰り返す。アンカーは必ず軌跡上の点になる。
   tol は世界座標での許容誤差。戻り値 {closed, points:[{x,y}...]}、点が足りなければ null。 */
function fitStroke(raw, tol){
  var pts=[], i, j;
  if(!raw || raw.length<2) return null;
  tol = tol>0 ? tol : 2;
  for(i=0;i<raw.length;i++){                   /* 近すぎる点を捨てる */
    var p=raw[i];
    if(!isFinite(p.x)||!isFinite(p.y)) continue;
    if(!pts.length || Math.hypot(p.x-pts[pts.length-1].x, p.y-pts[pts.length-1].y) > 0.5)
      pts.push({x:p.x, y:p.y});
  }
  if(pts.length<2) return null;
  if(pts.length>500){                          /* コアレスされたペン入力は数千点になる */
    var thin=[], st=(pts.length-1)/499;
    for(i=0;i<500;i++) thin.push(pts[Math.round(i*st)]);
    pts=thin;
  }
  /* 端どうしが近ければ閉じたストロークとみなす */
  var closed=false, span=0;
  for(i=1;i<pts.length;i++) span=Math.max(span, Math.hypot(pts[i].x-pts[0].x, pts[i].y-pts[0].y));
  if(pts.length>=8 && Math.hypot(pts[pts.length-1].x-pts[0].x, pts[pts.length-1].y-pts[0].y)
       < Math.max(tol*4, span*0.06)){ closed=true; pts.pop(); }
  var idx = closed ? [0, Math.floor(pts.length/3), Math.floor(pts.length*2/3)]
                   : [0, pts.length-1];
  idx = idx.filter(function(v,k){return idx.indexOf(v)===k});
  if(closed && idx.length<3) closed=false, idx=[0, pts.length-1];

  var guard=0;
  while(guard++ < 80){
    var D=idx.map(function(k){return pts[k]});
    var f = closed ? fitClosed(D,3) : fitOpen(D,3,{});
    if(!f) return null;
    var c=f.curve, N=Math.max(240, idx.length*30), samp=[];
    for(i=0;i<=N;i++) samp.push(evalCurve(c, c.u0+(c.u1-c.u0)*i/N));
    var worst=-1, wi=-1;
    for(i=0;i<pts.length;i++){
      if(idx.indexOf(i)>=0) continue;
      var mn=Infinity;
      for(j=0;j<samp.length;j++){
        var dx=samp[j].x-pts[i].x, dy=samp[j].y-pts[i].y, d=dx*dx+dy*dy;
        if(d<mn) mn=d;
      }
      if(mn>worst){ worst=mn; wi=i; }
    }
    if(wi<0 || Math.sqrt(worst)<=tol)
      return {closed:closed, points:D.map(function(p2){return {x:p2.x, y:p2.y}})};
    idx.push(wi); idx.sort(function(a,b){return a-b});
  }
  var Df=idx.map(function(k){return pts[k]});
  return {closed:closed, points:Df};
}

/* ---------- 5. 開いたパスの塗り判定：自己交差ループ ---------- */

/* 3次ベジェの点。t=0..1。 */
function bezPoint(seg,t){
  var mt=1-t;
  var abx=seg.p0.x*mt+seg.c1.x*t, aby=seg.p0.y*mt+seg.c1.y*t;
  var bcx=seg.c1.x*mt+seg.c2.x*t, bcy=seg.c1.y*mt+seg.c2.y*t;
  var cdx=seg.c2.x*mt+seg.p1.x*t, cdy=seg.c2.y*mt+seg.p1.y*t;
  var abcx=abx*mt+bcx*t, abcy=aby*mt+bcy*t;
  var bcdx=bcx*mt+cdx*t, bcdy=bcy*mt+cdy*t;
  return {x:abcx*mt+bcdx*t, y:abcy*mt+bcdy*t};
}

/* de Casteljau で t の位置から2分割。left=[0,t] / right=[t,1]。 */
function splitBez(seg,t){
  var mt=1-t;
  var abx=seg.p0.x*mt+seg.c1.x*t, aby=seg.p0.y*mt+seg.c1.y*t;
  var bcx=seg.c1.x*mt+seg.c2.x*t, bcy=seg.c1.y*mt+seg.c2.y*t;
  var cdx=seg.c2.x*mt+seg.p1.x*t, cdy=seg.c2.y*mt+seg.p1.y*t;
  var abcx=abx*mt+bcx*t, abcy=aby*mt+bcy*t;
  var bcdx=bcx*mt+cdx*t, bcdy=bcy*mt+cdy*t;
  var mx=abcx*mt+bcdx*t, my=abcy*mt+bcdy*t;
  return {
    left:{p0:{x:seg.p0.x,y:seg.p0.y}, c1:{x:abx,y:aby}, c2:{x:abcx,y:abcy}, p1:{x:mx,y:my}},
    right:{p0:{x:mx,y:my}, c1:{x:bcdx,y:bcdy}, c2:{x:cdx,y:cdy}, p1:{x:seg.p1.x,y:seg.p1.y}}
  };
}

function ctrlPolyLen(seg){
  return Math.hypot(seg.c1.x-seg.p0.x, seg.c1.y-seg.p0.y)
       + Math.hypot(seg.c2.x-seg.c1.x, seg.c2.y-seg.c1.y)
       + Math.hypot(seg.p1.x-seg.c2.x, seg.p1.y-seg.c2.y);
}

/* 3次ベジェの1階・2階微分。t=0..1。 */
function bezDeriv1(seg,t){
  var mt=1-t;
  return {
    x: 3*mt*mt*(seg.c1.x-seg.p0.x) + 6*mt*t*(seg.c2.x-seg.c1.x) + 3*t*t*(seg.p1.x-seg.c2.x),
    y: 3*mt*mt*(seg.c1.y-seg.p0.y) + 6*mt*t*(seg.c2.y-seg.c1.y) + 3*t*t*(seg.p1.y-seg.c2.y)
  };
}
function bezDeriv2(seg,t){
  var mt=1-t;
  return {
    x: 6*mt*(seg.c2.x-2*seg.c1.x+seg.p0.x) + 6*t*(seg.p1.x-2*seg.c2.x+seg.c1.x),
    y: 6*mt*(seg.c2.y-2*seg.c1.y+seg.p0.y) + 6*t*(seg.p1.y-2*seg.c2.y+seg.c1.y)
  };
}

/* 1つの区間上で、点qに最も近い位置をNewton法で精密化する。t0=粗い探索で見つけた初期値。
   f(t)=|B(t)-q|^2 の停留点（f'(t)=0）をNewton法で解く。8回で収束しなければ打ち切り、
   直前の値をそのまま返す（発散はしない設計：各歩幅は t を [0,1] にクランプする）。 */
function refineClosest(seg,q,t0){
  var t=t0, i;
  for(i=0;i<8;i++){
    var p=bezPoint(seg,t), d1=bezDeriv1(seg,t), d2=bezDeriv2(seg,t);
    var dx=p.x-q.x, dy=p.y-q.y;
    var fp = dx*d1.x+dy*d1.y;                                  /* f'(t)/2 */
    var fpp = d1.x*d1.x+d1.y*d1.y + dx*d2.x+dy*d2.y;            /* f''(t)/2 */
    if(Math.abs(fpp)<1e-9) break;
    var tn = t - fp/fpp;
    if(!isFinite(tn)) break;
    tn = Math.max(0, Math.min(1, tn));
    if(Math.abs(tn-t)<1e-10){ t=tn; break; }
    t=tn;
  }
  return t;
}

/* 曲線（区間の配列）の中で、点qに最も近い位置を求める。
   粗い探索（区間ごとに弧長からサンプル数を決める。fillLoopsと同じ考え方）で
   当たりを付けたあと、その区間の中をNewton法で精密化する。
   以前は区間ごとに固定50分割の中から最近サンプルを選ぶだけで、区間が長いと
   数〜十数px のズレが出ていた（2026-08-13、実測で確認）。
   戻り値 {si, t, x, y, d}：si=区間番号、t=区間内パラメータ、x,y=座標、d=距離。 */
function closestOnCurve(segs,q){
  if(!segs || !segs.length) return null;
  var best=null, si, k;
  for(si=0; si<segs.length; si++){
    var s=segs[si], len=ctrlPolyLen(s);
    var n=Math.min(64, Math.max(8, Math.ceil(len/4)));
    for(k=0;k<=n;k++){
      var t=k/n, p=bezPoint(s,t), d=Math.hypot(p.x-q.x,p.y-q.y);
      if(!best || d<best.d) best={si:si, t:t, d:d};
    }
  }
  if(!best) return null;
  var seg=segs[best.si];
  var t=refineClosest(seg,q,best.t);
  var p=bezPoint(seg,t);
  return {si:best.si, t:t, x:p.x, y:p.y, d:Math.hypot(p.x-q.x,p.y-q.y)};
}

/* 線分同士の交差。両方とも端点そのもの（s,r が 0 か 1）は交差扱いにしない
   ＝平坦化で生まれた隣接ピースの共有点を誤検出しない。 */
function segLineIntersect(p1,p2,q1,q2){
  var d1x=p2.x-p1.x, d1y=p2.y-p1.y, d2x=q2.x-q1.x, d2y=q2.y-q1.y;
  var denom=d1x*d2y-d1y*d2x;
  if(Math.abs(denom)<1e-12) return null;
  var ex=q1.x-p1.x, ey=q1.y-p1.y;
  var s=(ex*d2y-ey*d2x)/denom;
  var r=(ex*d1y-ey*d1x)/denom;
  if(s<=0||s>=1||r<=0||r>=1) return null;
  return {s:s,r:r};
}

/* 大域パラメータ u..v（= 区間番号+区間内t）の部分曲線を切り出す。
   同じ区間内なら1本、またがれば両端を割って間の区間をそのまま挟む。 */
function subCurve(segs,u,v){
  var su=Math.floor(u), tu=u-su, sv=Math.floor(v), tv=v-sv, k;
  if(su>=segs.length){ su=segs.length-1; tu=1; }
  if(sv>=segs.length){ sv=segs.length-1; tv=1; }
  if(su===sv){
    var right=splitBez(segs[su],tu).right;
    var lv=(1-tu)>1e-9 ? (tv-tu)/(1-tu) : 1;
    lv=Math.min(1,Math.max(0,lv));
    return [splitBez(right,lv).left];
  }
  var out=[splitBez(segs[su],tu).right];
  for(k=su+1;k<sv;k++) out.push(segs[k]);
  out.push(splitBez(segs[sv],tv).left);
  return out;
}

/* 開いたパスの塗り判定：曲線自身の自己交差が作る閉ループだけを返す。
   端点どうしを結んでできる領域はここには含まれない（交差が無ければ空配列）。
   segs = 3次ベジェ区間の配列（{p0,c1,c2,p1}）。tol = 平坦化の許容誤差（既定0.25px）。
   戻り値 = ループの配列。各ループは同形式の3次ベジェ区間列（部分曲線。始点と終点は
   交差点でほぼ一致するので、描画側は fill()（暗黙に閉じる）または 'Z' で閉じればよい）。

   【重なりの扱い】曲線の各区間はどのループにも重複せず1回だけ使われる
   （Seifert分解：各交差点で向きを保ったまま繋ぎ替え、開いた両端を含む鎖を
   除いた残りを閉ループとして取り出す）。塗った結果は evenodd で正しく
   交互に抜ける。以前は交差ペアごとに [u,v] 区間をそのまま集めていたが、
   絡みが密な曲線では複数のループが同じ区間を共有し、evenoddで重ねたときに
   区間が二重・三重に数えられてパリティが壊れ、本来交互に抜けるはずの模様が
   丸ごと1つの黒い塊になる不具合があった（2026-08-13、実際の絵で発見）。 */
function fillLoops(segs,tol){
  if(!segs||segs.length<1) return [];
  tol = tol>0?tol:0.25;
  var poly=[], k,i,j;
  for(k=0;k<segs.length;k++){
    var len=ctrlPolyLen(segs[k]);
    var n=Math.min(64, Math.max(6, Math.ceil(len/Math.max(tol,0.01))));
    var start = k===0?0:1;                    /* 継ぎ目の点を重複させない */
    for(i=start;i<=n;i++) poly.push({g:k+i/n, pt:bezPoint(segs[k],i/n)});
  }
  var hits=[];
  for(i=0;i<poly.length-1;i++){
    for(j=i+2;j<poly.length-1;j++){
      var hit=segLineIntersect(poly[i].pt, poly[i+1].pt, poly[j].pt, poly[j+1].pt);
      if(!hit) continue;
      var u=poly[i].g+(poly[i+1].g-poly[i].g)*hit.s;
      var v=poly[j].g+(poly[j+1].g-poly[j].g)*hit.r;
      if(v<=u) continue;
      hits.push({u:u,v:v});
    }
  }
  if(!hits.length) return [];

  /* イベント列 = 開始(t=0) + 終了(t=segs.length) + 各交差の2訪問(p,q)。
     イベントで区切られた区間が「arc」。arc[k] はイベント[k]で始まりイベント[k+1]で終わる。 */
  var events=[{t:0}, {t:segs.length}];
  hits.forEach(function(h){
    var p={t:h.u}, q={t:h.v};
    p.partner=q; q.partner=p;
    events.push(p, q);
  });
  events.sort(function(a,b){ return a.t-b.t; });
  var idxOf = new Map();
  events.forEach(function(e,i){ idxOf.set(e,i); });

  var m = events.length-1;
  var arcT0=new Array(m), arcT1=new Array(m);
  for(i=0;i<m;i++){ arcT0[i]=events[i].t; arcT1[i]=events[i+1].t; }

  /* next[arc] = このarcの次に繋がるarc。交差点では「向きを保つ繋ぎ替え」で
     パートナー側の出口へ渡す（Seifertの平滑化）。終端イベントの手前は次が無い（-1）。 */
  var next=new Array(m).fill(-1);
  for(i=1;i<events.length;i++){
    var inArc=i-1, e=events[i];
    if(i===events.length-1) continue;   /* 終端。開いた端はここで止まる */
    if(!e.partner) continue;            /* 防御（通常ここには来ない） */
    next[inArc]=idxOf.get(e.partner);
  }

  var visited=new Array(m).fill(false);
  /* 開始イベントから辿れる鎖は「両端が開いたまま」なので塗りの対象にしない */
  (function(){
    var cur=0;
    while(cur>=0 && cur<m && !visited[cur]){ visited[cur]=true; cur=next[cur]; }
  })();

  var loops=[];
  for(i=0;i<m;i++){
    if(visited[i]) continue;
    var cyc=[], cur=i, guard=0;
    while(cur>=0 && !visited[cur] && guard++<m+2){
      visited[cur]=true; cyc.push(cur); cur=next[cur];
    }
    if(cur===i && cyc.length){
      var geo=[];
      for(var ci=0; ci<cyc.length; ci++) geo=geo.concat(subCurve(segs, arcT0[cyc[ci]], arcT1[cyc[ci]]));
      /* 継ぎ目のスナップ：Seifertの繋ぎ替えでは、隣り合う区間は「同じ交差点」で
         繋がるはずだが、その点は別々の subCurve 呼び出し（別々のsplitBezの連鎖）で
         それぞれ独立に計算されるため、浮動小数点の丸めで数px万分の1〜百分の1ほど
         ズレることがある。描画側（traceSegs・pathD）は「前の区間の終点と一致するか」
         を極小許容差(1e-6)で見て新しいサブパスを始めるかどうか判定しているため、
         このズレがあると閉じないまま次のMを打ってしまい、塗りが壊れる
         （2026-08-13、実際の絵で発見）。前の区間の終点にきっちり合わせて防ぐ。 */
      for(var gi=1; gi<geo.length; gi++){
        geo[gi] = {p0:{x:geo[gi-1].p1.x, y:geo[gi-1].p1.y}, c1:geo[gi].c1, c2:geo[gi].c2, p1:geo[gi].p1};
      }
      loops.push(geo);
    }
  }
  return loops;
}

return {
  buildCurve:buildCurve, curveOf:curveOf, findSpan:findSpan, basisFuns:basisFuns,
  basisVector:basisVector, evalCurve:evalCurve, derivCurve:derivCurve,
  spanBreaks:spanBreaks, toBeziers:toBeziers, insertKnot:insertKnot,
  gauss:gauss, solveBanded:solveBanded, solveTridiag:solveTridiag,
  solveCyclicTridiag:solveCyclicTridiag, chordParams:chordParams,
  fitOpen:fitOpen, fitClosed:fitClosed, fitStroke:fitStroke, fillLoops:fillLoops,
  closestOnCurve:closestOnCurve,
  /* ベジェ区間の小道具。shape.js（面の抽出）が使う */
  bezPoint:bezPoint, splitBez:splitBez, bezDeriv1:bezDeriv1, bezDeriv2:bezDeriv2,
  ctrlPolyLen:ctrlPolyLen, segLineIntersect:segLineIntersect, subCurve:subCurve
};
});
