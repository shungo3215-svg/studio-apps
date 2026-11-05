/* ============================================================================
   svgin.js — Illustrator から貼った SVG を、劣化なしで取り込む

   要点は 1 つだけ:
     **d 属性を直接読む。点列にサンプルしない。**

   motifs.js の fromSVG は getTotalLength / getPointAtLength でブラウザに点を
   出させてから smooth で繋ぎ直していた。これはこのプロジェクトが 3 度作り直した
   根本原因（＝形を点列で持つ）そのもので、しかも今回は避けられる:
   Illustrator のパスは元から 3 次ベジェなので、d を読めば無損失で入る。
   getPointAtLength は「元が持っていた曲率」を捨てて等間隔の点に潰す変換であり、
   その後どれだけ滑らかに繋ぎ直しても、捨てた情報は戻らない。

   ここでやっている変換はすべて**厳密**:
     - Q/T → C は 2 次を 3 次へ昇格する恒等式（形は 1 mm も変わらない）
     - A（円弧）だけは近似（円弧は有理ベジェなので多項式では書けない）。
       90°以下に割って K 近似するので誤差は 1e-4 のオーダー
     - transform（getCTM）はアフィンなので、制御点に掛けるだけで厳密。
       「3 次ベジェのアフィン像は 3 次ベジェ」だから割り直す必要がない
     - rect / circle / ellipse / polygon も式から直接ベジェを作る（サンプルしない）

   契約: window.SvgIn.parse(text) → [{segs, closed, fill}] または null
         **曲線の通る範囲**が [-1,1] の正方形に収まる（アスペクト比は保つ）。
         制御点はこの外へ出うる。腕の長い S 字なら実測で 1.25 程度まで出る。
         正規化は「制御点の凸包」ではなく「曲線の真の bbox」で測っているので当然で、
         逆にすると同じ絵を貼っても腕の長さで大きさが変わる（§6 参照）。
         受け手が制御点を直接クリップ・判定に使うなら、そちら側で余裕を持つこと。
   ========================================================================== */
(function (global) {
  'use strict';

  var G = global.Geom;
  var EPS = 1e-9;

  /* ==========================================================================
     1. 数値スキャナ
     SVG の数値は「区切り記号を省ける」のが厄介。Illustrator は容赦なく詰めてくる:
       "1.5.5"  → 1.5 と .5（小数点は 1 個までしか食べない）
       "1-2"    → 1 と -2（符号が区切りを兼ねる）
       "1e-5"   → これは 1 個の数値。上の規則を単純に当てると壊れる
     つまり「区切りで split する」実装は必ず壊れる。1 文字ずつ舐めるしかない。
     ========================================================================== */

  function scanner(str){ return { s: String(str == null ? '' : str), i: 0 }; }

  function isDigit(c){ return c >= '0' && c <= '9'; }
  // 仕様上の wsp は 0x20/0x9/0xA/0xD（+0xC）だけ。だがここは**貼り付け**が入口なので、
  // Web や PDF から拾った NBSP(00A0) や全角空白、行区切り(2028/2029)、BOM(FEFF) が混ざる。
  // 仕様どおりに弾くとブラウザ同様「そこでパスが切れる」だけで、しかも何も言わずに切れる。
  // 区切りとして飲むほうが安全（これらの文字が数値やコマンドの一部になることは無い）
  function isWS(c){
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' ||
           c === '\u00a0' || c === '\u3000' || c === '\u2028' || c === '\u2029' || c === '\ufeff';
  }

  function skipSep(sc){
    var s = sc.s, n = s.length, c;
    while (sc.i < n){
      c = s.charAt(sc.i);
      if (isWS(c) || c === ',') sc.i++; else break;
    }
  }

  function readNumber(sc){
    var s = sc.s, n = s.length, i = sc.i, start = i, digits = false, c;
    c = s.charAt(i);
    if (c === '+' || c === '-') i++;
    while (i < n && isDigit(s.charAt(i))) { i++; digits = true; }
    if (i < n && s.charAt(i) === '.'){
      i++;                                   // 小数点は 1 個だけ。2 個目で次の数値が始まる
      while (i < n && isDigit(s.charAt(i))) { i++; digits = true; }
    }
    if (!digits) return null;                // 符号や '.' だけでは数値にならない
    if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')){
      var j = i + 1, expDigits = false;
      if (j < n && (s.charAt(j) === '+' || s.charAt(j) === '-')) j++;
      while (j < n && isDigit(s.charAt(j))) { j++; expDigits = true; }
      if (expDigits) i = j;                  // 指数部に数字が無ければ 'e' は数値の外
    }
    var v = parseFloat(s.slice(start, i));
    // "1e999" のように double で表せない値。**必ず消費してから** 諦める。
    // ここで i を進めずに返すと、呼び手（readNumbers）が 1 文字だけ進めて
    // 残りの "999" を新しい数として拾い、1e999 が 999 に化ける（実際に化けた）
    sc.i = i;
    if (!isFinite(v)) return null;
    return v;
  }

  /* 文字列から数値を全部拾う（polygon/polyline の points 用） */
  function readNumbers(text){
    var sc = scanner(text), out = [], v;
    for (;;){
      skipSep(sc);
      if (sc.i >= sc.s.length) break;
      v = readNumber(sc);
      if (v === null){ sc.i++; continue; }    // 読めない字は飛ばす（"10px" 等の混入に耐える）
      out.push(v);
    }
    return out;
  }

  function readArgs(sc, count){
    var a = [], v;
    for (var i = 0; i < count; i++){
      skipSep(sc);
      v = readNumber(sc);
      if (v === null) return null;
      a.push(v);
    }
    return a;
  }

  function readFlag(sc){
    skipSep(sc);
    var c = sc.s.charAt(sc.i);
    // 仕様上フラグは 1 文字。"0110 0" のように区切り無しで来ても割れるようにする
    // （数値として読むと "0110" を 1 個の数だと思って弧全体がずれる）
    if (c === '0' || c === '1'){ sc.i++; return c === '1' ? 1 : 0; }
    var v = readNumber(sc);
    return v === null ? null : (v ? 1 : 0);
  }

  /* ==========================================================================
     2. 円弧 A → 3 次ベジェ
     endpoint 記法（終点と半径だけ）→ center 記法（中心と角度）へ変換してから、
     90°以下に割って各弧を K 近似する。仕様 F.6.5 の手順そのまま。
     Illustrator の書き出しに A は稀だが、Figma や d3 からの貼り付けでは普通に来る。
     ========================================================================== */
  function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2){
    // 始点と終点が同じなら弧は無かったことにする（仕様通り。ここを線にすると
    // 長さ 0 のセグメントが残って、写した先で接線が測れず荒れる）
    if (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < EPS || ry < EPS) return [G.line([x1, y1], [x2, y2])];  // 半径 0 は直線

    var phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var x1p =  cp * dx + sp * dy;
    var y1p = -sp * dx + cp * dy;

    // 半径が足りなければ、届く最小まで一様に膨らませる（仕様 F.6.6）
    var lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1){ var k = Math.sqrt(lam); rx *= k; ry *= k; }

    var rx2 = rx * rx, ry2 = ry * ry;
    var den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    var num = rx2 * ry2 - den;
    var co = Math.sqrt(Math.max(0, num / den));   // 丸め誤差で負になるので max で止める
    if (largeArc === sweep) co = -co;
    var cxp =  co * rx * y1p / ry;
    var cyp = -co * ry * x1p / rx;
    var cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
    var cy = sp * cxp + cp * cyp + (y1 + y2) / 2;

    var ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    var vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    var th1 = Math.atan2(uy, ux);
    var dth = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dth > 0) dth -= Math.PI * 2;
    if (sweep && dth < 0) dth += Math.PI * 2;

    // 楕円上の点と接ベクトル。ここから先はアフィン写像なので、
    // 単位円の 3 次近似をそのまま楕円へ持ち込める（＝非等方スケールしても厳密に同じ近似度）
    function P(t){
      var c = Math.cos(t), s = Math.sin(t);
      return [cx + rx * c * cp - ry * s * sp, cy + rx * c * sp + ry * s * cp];
    }
    function D(t){
      var c = Math.cos(t), s = Math.sin(t);
      return [-rx * s * cp - ry * c * sp, -rx * s * sp + ry * c * cp];
    }

    var n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
    var d = dth / n, out = [];
    // 腕の長さ (4/3)tan(δ/4)。δ=90° のとき (4/3)tan(22.5°) = 0.5522847… = Geom.K に一致する。
    // つまりこれは K 近似を任意角へ一般化したもの（最後の半端な弧のために必要）
    var alpha = 4 / 3 * Math.tan(d / 4);
    for (var i = 0; i < n; i++){
      var t0 = th1 + d * i, t1 = t0 + d;
      var p0 = P(t0), p3 = P(t1), d0 = D(t0), d3 = D(t1);
      // 端点は endpoint 記法の値で上書きする。半径補正を挟むと P(t) が
      // 元の端点から数 1e-13 ずれ、繋ぎ目に隙間が残るため
      if (i === 0) p0 = [x1, y1];
      if (i === n - 1) p3 = [x2, y2];
      out.push(G.cubic(p0,
        [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1]],
        [p3[0] - alpha * d3[0], p3[1] - alpha * d3[1]], p3));
    }
    return out;
  }

  /* ==========================================================================
     3. d 属性のパーサ
     戻り値: [{segs:[…], closed:bool}]（サブパスごとに 1 つ）
     ========================================================================== */
  var CMD = /[MmLlHhVvCcSsQqTtAaZz]/;

  function parseD(d){
    var sc = scanner(d), subs = [], cur = null;
    var x = 0, y = 0, sx = 0, sy = 0;
    var prevCtrl = null;      // 直前の制御点（S/T の反射用）
    var prevKind = '';        // 'C' か 'Q' か空。反射できるのは同種の直後だけ
    var cmd = '', ch, a, rel, nx, ny, p1, p2, p3, q, i, arcs, laf, swf, ep;

    function open(){ if (!cur){ cur = { segs: [], closed: false }; sx = x; sy = y; } }
    function flush(){ if (cur && cur.segs.length) subs.push(cur); cur = null; }
    // 壊れた d に当たったら、そこまでを**残して**諦める。
    // 素の `return subs` だと、作りかけの cur が push されないまま捨てられるので、
    // 現在のサブパスが丸ごと消える。ブラウザは「エラー直前まで描く」ので挙動も合わない。
    // （NBSP 1 個で三角形が全部消える、という形で実際に踏んだ）
    function bail(){ flush(); return subs; }

    for (;;){
      skipSep(sc);
      if (sc.i >= sc.s.length) break;
      ch = sc.s.charAt(sc.i);
      if (CMD.test(ch)){ cmd = ch; sc.i++; skipSep(sc); }
      else if (!cmd) break;   // コマンドより先に数値が来た＝壊れた d。黙って諦める
      rel = cmd >= 'a';       // 小文字＝相対

      switch (cmd.toUpperCase()){

      case 'M':
        a = readArgs(sc, 2); if (!a) return bail();
        flush();
        x = rel ? x + a[0] : a[0];
        y = rel ? y + a[1] : a[1];
        open();
        prevKind = '';
        // **暗黙の lineto**: M の後に座標が続いたら 2 つ目以降は L 扱い（m なら l）。
        // ここを実装しないと Illustrator の多角形が 1 点に潰れる
        cmd = rel ? 'l' : 'L';
        break;

      case 'L':
        a = readArgs(sc, 2); if (!a) return bail();
        open();
        nx = rel ? x + a[0] : a[0]; ny = rel ? y + a[1] : a[1];
        cur.segs.push(G.line([x, y], [nx, ny]));
        x = nx; y = ny; prevKind = '';
        break;

      case 'H':
        a = readArgs(sc, 1); if (!a) return bail();
        open();
        nx = rel ? x + a[0] : a[0];
        cur.segs.push(G.line([x, y], [nx, y]));
        x = nx; prevKind = '';
        break;

      case 'V':
        a = readArgs(sc, 1); if (!a) return bail();
        open();
        ny = rel ? y + a[0] : a[0];
        cur.segs.push(G.line([x, y], [x, ny]));
        y = ny; prevKind = '';
        break;

      case 'C':
        a = readArgs(sc, 6); if (!a) return bail();
        open();
        p1 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
        p2 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
        p3 = [rel ? x + a[4] : a[4], rel ? y + a[5] : a[5]];
        cur.segs.push(G.cubic([x, y], p1, p2, p3));
        x = p3[0]; y = p3[1]; prevCtrl = p2; prevKind = 'C';
        break;

      case 'S':
        a = readArgs(sc, 4); if (!a) return bail();
        open();
        // 直前が C/S でなければ反射する相手がいない。現在点をそのまま使う（仕様通り）
        p1 = (prevKind === 'C' && prevCtrl) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
        p2 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
        p3 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
        cur.segs.push(G.cubic([x, y], p1, p2, p3));
        x = p3[0]; y = p3[1]; prevCtrl = p2; prevKind = 'C';
        break;

      case 'Q':
        a = readArgs(sc, 4); if (!a) return bail();
        open();
        q  = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
        p3 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
        cur.segs.push(quadToCubic([x, y], q, p3));
        x = p3[0]; y = p3[1]; prevCtrl = q; prevKind = 'Q';
        break;

      case 'T':
        a = readArgs(sc, 2); if (!a) return bail();
        open();
        q = (prevKind === 'Q' && prevCtrl) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
        p3 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
        cur.segs.push(quadToCubic([x, y], q, p3));
        x = p3[0]; y = p3[1]; prevCtrl = q; prevKind = 'Q';
        break;

      case 'A':
        a = readArgs(sc, 3); if (!a) return bail();
        laf = readFlag(sc); swf = readFlag(sc);
        if (laf === null || swf === null) return bail();
        ep = readArgs(sc, 2); if (!ep) return bail();
        open();
        nx = rel ? x + ep[0] : ep[0]; ny = rel ? y + ep[1] : ep[1];
        arcs = arcToCubics(x, y, a[0], a[1], a[2], laf, swf, nx, ny);
        for (i = 0; i < arcs.length; i++) cur.segs.push(arcs[i]);
        x = nx; y = ny; prevKind = '';
        break;

      case 'Z':
        if (cur){
          // 閉じ線は**実体として持つ**。closed フラグだけにすると、球へ写すときに
          // この 1 本だけ写されず、閉じ口が画面上の直線になってしまう
          if (Math.abs(x - sx) > EPS || Math.abs(y - sy) > EPS)
            cur.segs.push(G.line([x, y], [sx, sy]));
          cur.closed = true;
          flush();
        }
        x = sx; y = sy; prevKind = '';
        cmd = '';   // Z は繰り返さない。ここを空にしないと数値が続いたとき無限ループする
        break;

      default:
        return bail();
      }
    }
    flush();
    return subs;
  }

  /* 2 次 → 3 次の昇格（厳密。形は一切変わらない） */
  function quadToCubic(p0, q, p3){
    return G.cubic(p0,
      [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])],
      [p3[0] + 2 / 3 * (q[0] - p3[0]), p3[1] + 2 / 3 * (q[1] - p3[1])], p3);
  }

  /* ==========================================================================
     4. アフィン行列 [a,b,c,d,e,f]
     3 次ベジェのアフィン像は 3 次ベジェなので、制御点を写すだけで厳密。
     （ここが「サンプルしない」を最後まで貫ける理由）
     ========================================================================== */
  function applyMatrix(m, p){
    return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  }
  function matMul(m, n){   // m ∘ n（n を先に適用）
    return [ m[0]*n[0] + m[2]*n[1], m[1]*n[0] + m[3]*n[1],
             m[0]*n[2] + m[2]*n[3], m[1]*n[2] + m[3]*n[3],
             m[0]*n[4] + m[2]*n[5] + m[4], m[1]*n[4] + m[3]*n[5] + m[5] ];
  }
  function mapSegs(segs, m){
    return segs.map(function(s){
      return s.type === 'L' ? G.line(applyMatrix(m, s.a), applyMatrix(m, s.b))
        : G.cubic(applyMatrix(m, s.p0), applyMatrix(m, s.p1),
                  applyMatrix(m, s.p2), applyMatrix(m, s.p3));
    });
  }

  /* ==========================================================================
     5. 基本図形（サンプルせずに式から作る）
     ========================================================================== */

  /* 角丸を含む rect。角は K 近似の 1/4 楕円弧。
     1/4 楕円は 1/4 円のアフィン像なので、腕を rx*K / ry*K と軸ごとに取れば
     円のときと同じ近似度になる（＝ここで arcToCubics を呼ぶ必要がない） */
  function rectSegs(x, y, w, h, rx, ry){
    if (!(w > 0) || !(h > 0)) return [];
    rx = Math.min(Math.max(rx || 0, 0), w / 2);
    ry = Math.min(Math.max(ry || 0, 0), h / 2);
    if (rx < EPS || ry < EPS)
      return G.polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    var kx = rx * G.K, ky = ry * G.K, s = [];
    var x0 = x, x1 = x + w, y0 = y, y1 = y + h;
    s.push(G.line([x0 + rx, y0], [x1 - rx, y0]));
    s.push(G.cubic([x1 - rx, y0], [x1 - rx + kx, y0], [x1, y0 + ry - ky], [x1, y0 + ry]));
    s.push(G.line([x1, y0 + ry], [x1, y1 - ry]));
    s.push(G.cubic([x1, y1 - ry], [x1, y1 - ry + ky], [x1 - rx + kx, y1], [x1 - rx, y1]));
    s.push(G.line([x1 - rx, y1], [x0 + rx, y1]));
    s.push(G.cubic([x0 + rx, y1], [x0 + rx - kx, y1], [x0, y1 - ry + ky], [x0, y1 - ry]));
    s.push(G.line([x0, y1 - ry], [x0, y0 + ry]));
    s.push(G.cubic([x0, y0 + ry], [x0, y0 + ry - ky], [x0 + rx - kx, y0], [x0 + rx, y0]));
    return s;
  }

  /* ==========================================================================
     6. bbox → [-1,1] へ正規化
     制御点の凸包ではなく**曲線の真の bbox** を取る。制御点で測ると、腕の長い
     カーブほど余白が付いて縮む（同じ絵を貼っても大きさが揃わない）。
     3 次ベジェの極値は導関数の 2 次方程式を解けば厳密に出る。
     ========================================================================== */
  function boundsOf(shapes){
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    function acc(p){
      if (!isFinite(p[0]) || !isFinite(p[1])) return;
      if (p[0] < bb[0]) bb[0] = p[0];
      if (p[1] < bb[1]) bb[1] = p[1];
      if (p[0] > bb[2]) bb[2] = p[0];
      if (p[1] > bb[3]) bb[3] = p[1];
    }
    shapes.forEach(function(sh){
      sh.segs.forEach(function(s){
        if (s.type === 'L'){ acc(s.a); acc(s.b); return; }
        acc(s.p0); acc(s.p3);
        for (var k = 0; k < 2; k++){
          // B'(t)/3 = at² + bt + c（A=P1-P0, B=P2-P1, C=P3-P2 として a=A-2B+C, b=2(B-A), c=A）
          var A = s.p1[k] - s.p0[k], B = s.p2[k] - s.p1[k], C = s.p3[k] - s.p2[k];
          var a = A - 2 * B + C, b = 2 * (B - A), c = A, ts = [];
          if (Math.abs(a) < 1e-12){ if (Math.abs(b) > 1e-12) ts.push(-c / b); }
          else {
            var disc = b * b - 4 * a * c;
            if (disc >= 0){
              var sq = Math.sqrt(disc);
              ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
            }
          }
          ts.forEach(function(t){ if (t > 0 && t < 1) acc(G.evalSeg(s, t)); });
        }
      });
    });
    return bb;
  }

  function normalize(shapes){
    var bb = boundsOf(shapes);
    if (!isFinite(bb[0]) || !isFinite(bb[2])) return null;
    var w = bb[2] - bb[0], h = bb[3] - bb[1];
    var half = Math.max(w, h) / 2;
    var sc = half > EPS ? 1 / half : 1;      // 1 点だけの図形で 0 除算しない
    var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    // y は反転しない。app.js は平面の +y を v の増加＝画面の下へ写すので、
    // SVG の y 下向きとそのまま噛み合う（反転すると貼った絵が上下逆になる）
    var m = [sc, 0, 0, sc, -cx * sc, -cy * sc];
    return shapes.map(function(sh){
      return { segs: mapSegs(sh.segs, m), closed: sh.closed, fill: sh.fill };
    });
  }

  /* ==========================================================================
     7. DOM を通す層（getCTM と getComputedStyle を効かせるため一度だけ挿す）
     ========================================================================== */

  var SKIP_ANCESTOR = { defs:1, clippath:1, mask:1, marker:1, symbol:1, pattern:1 };

  /* defs や clipPath の中身は描かれない。拾ってしまうと、アートボード全面の
     クリップ矩形が bbox に混ざって、絵が真ん中の小さな点になる（実際に起きる） */
  function isRendered(el){
    var p = el, tag;
    while (p && p.nodeType === 1){
      tag = String(p.nodeName).toLowerCase();
      if (tag === 'body' || tag === 'html') break;      // 差し込み先のホストまで来たら終わり
      if (SKIP_ANCESTOR[tag]) return false;
      // **display は継承しない。** 要素の計算値だけ見ても、親が display:none でも
      // 子の計算値は 'inline' のままなので素通りする。Illustrator の非表示レイヤーは
      // <g display="none"> で出てくるので、これを拾うとレイヤー全面の矩形が bbox に
      // 混ざって、本来の絵が中央の点に潰れる（実測で 1 個→2 個の形になった）
      try { if (global.getComputedStyle(p).display === 'none') return false; } catch (e) {}
      p = p.parentNode;
    }
    // visibility は逆に継承するので、要素の計算値を 1 回見れば祖先ごと拾える
    try { if (global.getComputedStyle(el).visibility === 'hidden') return false; } catch (e2) {}
    return true;
  }

  function elementMatrix(el){
    var m = null;
    // getScreenCTM を先に試す: 入れ子の <svg> があると getCTM は「内側のビューポート」で
    // 止まるので、要素ごとに基準がずれて配置が壊れる。画面座標のオフセットは
    // どうせ後段の正規化で消えるため、共通の基準に載るほうが得
    try { if (el.getScreenCTM) m = el.getScreenCTM(); } catch (e){ m = null; }
    if (!m){ try { if (el.getCTM) m = el.getCTM(); } catch (e2){ m = null; } }
    if (!m) return [1, 0, 0, 1, 0, 0];
    var a = [m.a, m.b, m.c, m.d, m.e, m.f];
    for (var i = 0; i < 6; i++) if (!isFinite(a[i])) return [1, 0, 0, 1, 0, 0];
    return a;
  }

  function attrNum(el, name, dflt){
    var v = parseFloat(el.getAttribute(name));
    return isFinite(v) ? v : dflt;
  }

  function isFilled(el){
    var cs = null, f;
    // 属性だけ見ると CSS（<style> や class）での指定を落とす。計算値で判定する
    try { cs = global.getComputedStyle(el); } catch (e){}
    f = cs ? cs.fill : el.getAttribute('fill');
    if (!f || f === 'none' || f === 'transparent') return false;
    // 計算値は色に解決されるので、生の 'transparent' で一致することは無い。
    // fill="transparent" は rgba(0,0,0,0) になる。α=0 を見ないと塗り扱いのままになる
    if (/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0(\.0+)?\s*\)$/.test(f)) return false;
    if (cs && parseFloat(cs.fillOpacity) === 0) return false;
    return true;
  }

  /* 端が開いたまま closed:true にすると、閉じ口だけ写されず直線になる。
     Z の無い塗り図形（SVG は自動で閉じる）でも実体の線を足しておく */
  function closeIfNeeded(segs){
    if (!segs.length) return segs;
    var a = G.segStart(segs[0]), b = G.segEnd(segs[segs.length - 1]);
    if (Math.abs(a[0] - b[0]) > EPS || Math.abs(a[1] - b[1]) > EPS) segs.push(G.line(b, a));
    return segs;
  }

  function shapesFromElement(el){
    var tag = String(el.nodeName).toLowerCase();
    var fill = isFilled(el), m = elementMatrix(el), out = [];

    function push(segs, closed, filled, mat){
      if (!segs || !segs.length) return;
      if (closed) closeIfNeeded(segs);
      out.push({ segs: mapSegs(segs, mat || m), closed: !!closed, fill: !!filled });
    }

    if (tag === 'path'){
      var subs = parseD(el.getAttribute('d'));
      subs.forEach(function(sub){
        // サブパスごとに 1 つの形にする。ドーナツ（外周＋内周）の穴は表現できないが、
        // 元の実装は複数サブパスを 1 本の線として繋いでいて更に壊れていた
        push(sub.segs, sub.closed || fill, fill);
      });
      return out;
    }
    if (tag === 'rect'){
      var rxA = el.getAttribute('rx'), ryA = el.getAttribute('ry');
      var rx = parseFloat(rxA), ry = parseFloat(ryA);
      if (!isFinite(rx) && !isFinite(ry)) rx = ry = 0;
      else if (!isFinite(rx)) rx = ry;         // 片方だけの指定はもう片方に揃える（仕様）
      else if (!isFinite(ry)) ry = rx;
      push(rectSegs(attrNum(el, 'x', 0), attrNum(el, 'y', 0),
                    attrNum(el, 'width', 0), attrNum(el, 'height', 0), rx, ry), true, fill);
      return out;
    }
    if (tag === 'circle'){
      var r = attrNum(el, 'r', 0);
      if (r > 0) push(G.circle(attrNum(el, 'cx', 0), attrNum(el, 'cy', 0), r), true, fill);
      return out;
    }
    if (tag === 'ellipse'){
      var ex = attrNum(el, 'rx', 0), ey = attrNum(el, 'ry', 0);
      if (ex > 0 && ey > 0){
        // 単位円に非等方スケールを掛ける＝アフィンなので厳密。CTM に畳んで一度で写す
        push(G.circle(0, 0, 1), true, fill,
             matMul(m, [ex, 0, 0, ey, attrNum(el, 'cx', 0), attrNum(el, 'cy', 0)]));
      }
      return out;
    }
    if (tag === 'line'){
      // 線分に面積は無いので塗りは付けない（既定の fill:black を鵜呑みにしない）
      push([G.line([attrNum(el, 'x1', 0), attrNum(el, 'y1', 0)],
                   [attrNum(el, 'x2', 0), attrNum(el, 'y2', 0)])], false, false);
      return out;
    }
    if (tag === 'polygon' || tag === 'polyline'){
      var n = readNumbers(el.getAttribute('points')), pts = [];
      for (var i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
      if (pts.length > 1){
        var closed = (tag === 'polygon') || fill;
        push(G.polyline(pts, closed), closed, fill);
      }
      return out;
    }
    return out;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var XLINKNS = 'http://www.w3.org/1999/xlink';

  /* 取り込む前に消すもの。
     この関数の入口は**貼り付け**なので、貼った SVG は他人の書いたコードだと思うこと。
     DOMParser で作った <script> は「パーサ挿入済み」フラグが立たないので、
     live な document へ append した瞬間に走る（Chrome で実際に走った）。
     図形しか読まないのだから、走らせる理由も、外部へ取りに行く理由も無い。 */
  var STRIP_EL = { script:1, foreignobject:1, iframe:1, image:1, audio:1, video:1, animate:1, set:1 };

  function sanitize(doc){
    var all = doc.getElementsByTagName('*'), i, el, at, j, nm;
    for (i = all.length - 1; i >= 0; i--){
      el = all[i];
      if (STRIP_EL[String(el.nodeName).toLowerCase()]){
        if (el.parentNode) el.parentNode.removeChild(el);
        continue;
      }
      at = el.attributes;
      for (j = at.length - 1; j >= 0; j--){
        nm = at[j].name;
        // onload / onclick …。<image> を消しても <a> や <animate> 経由が残るので属性でも切る
        if (/^on/i.test(nm)) el.removeAttribute(nm);
      }
    }
  }

  /* <use> を実体へ展開する。
     参照先は普通 <defs> や <symbol> の中にいて、isRendered が（正しく）落とす。
     展開しないと「絵が丸ごと消えて null」になる。アイコン系の書き出しでは普通に来る形。
     x/y は translate に畳む（仕様どおり）。<symbol> の viewBox スケーリングまでは見ない。 */
  function expandUses(doc){
    var byId = {}, all = doc.getElementsByTagName('*'), i, id;
    for (i = 0; i < all.length; i++){
      id = all[i].getAttribute && all[i].getAttribute('id');
      if (id && !byId[id]) byId[id] = all[i];
    }
    var budget = 400;                      // 自己参照で無限に増えるのを止める
    for (var pass = 0; pass < 6; pass++){
      var uses = doc.getElementsByTagName('use');
      if (!uses.length) break;
      var did = false;
      for (i = uses.length - 1; i >= 0; i--){
        var u = uses[i];
        if (!u.parentNode) continue;
        var href = u.getAttribute('href') ||
                   (u.getAttributeNS ? u.getAttributeNS(XLINKNS, 'href') : null) ||
                   u.getAttribute('xlink:href') || '';
        var m = /^\s*#(.+?)\s*$/.exec(href);
        var src = m ? byId[m[1]] : null;
        // 参照先が自分自身 or 自分の祖先なら無限再帰。諦めて <use> を消す
        if (src){ for (var a = u; a; a = a.parentNode) if (a === src){ src = null; break; } }
        if (!src || --budget < 0){ u.parentNode.removeChild(u); did = true; continue; }

        var g = doc.createElementNS(SVGNS, 'g');
        var tr = (u.getAttribute('transform') || '').trim();
        var ux = parseFloat(u.getAttribute('x')) || 0, uy = parseFloat(u.getAttribute('y')) || 0;
        if (ux || uy) tr = (tr + ' translate(' + ux + ',' + uy + ')').trim();
        if (tr) g.setAttribute('transform', tr);
        // 見た目の指定は <use> 側に載っていることがある（継承させる）
        ['fill', 'stroke', 'style', 'class', 'display', 'visibility'].forEach(function(k){
          if (u.getAttribute(k) != null) g.setAttribute(k, u.getAttribute(k));
        });

        var tag = String(src.nodeName).toLowerCase(), c;
        if (tag === 'symbol' || tag === 'svg'){
          for (c = src.firstChild; c; c = c.nextSibling) g.appendChild(c.cloneNode(true));
        } else {
          g.appendChild(src.cloneNode(true));
        }
        stripIds(g);                       // clone した id が元の参照を横取りしないように
        u.parentNode.replaceChild(g, u);
        did = true;
      }
      if (!did) break;
    }
  }

  function stripIds(root){
    if (root.removeAttribute) root.removeAttribute('id');
    var kids = root.getElementsByTagName ? root.getElementsByTagName('*') : [];
    for (var i = 0; i < kids.length; i++)
      if (kids[i].removeAttribute) kids[i].removeAttribute('id');
  }

  function parse(text){
    if (!text || !String(text).trim()) return null;
    if (typeof global.DOMParser !== 'function') return null;
    var src = String(text);
    // 中身だけ（<path .../> など）を貼られることも多いので、その場合は包む
    var markup = /<svg[\s>]/i.test(src) ? src
      : '<svg xmlns="http://www.w3.org/2000/svg">' + src + '</svg>';

    // **xmlns が無い SVG を必ず補う。** HTML に直書きされた inline SVG をコピペすると
    // xmlns が付いていないことがあり、XML として読むと要素が「名前空間なし」になる。
    // すると見た目は同じ木なのに:
    //   - getCTM / getScreenCTM が生えない → viewBox や transform が丸ごと消える
    //   - fill の計算値が常に黒 → fill="none" の線画まで塗り扱いになる
    // しかもエラーは出ないので、静かに全部ずれる。実際にこれで踏んだ
    if (!/<svg[^>]*\sxmlns\s*=/i.test(markup))
      markup = markup.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    // xlink は宣言漏れがあると XML パースごと落ちる（＝黙って null）。先に足しておく
    if (/\sxlink:/i.test(markup) && !/xmlns:xlink\s*=/i.test(markup))
      markup = markup.replace(/<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');

    // XML が知っている実体は 5 個だけ。HTML から拾った &nbsp; が 1 個混ざるだけで
    // パースごと落ちて **絵が丸ごと null になる**（<title>A&nbsp;B</title> で実証）。
    // 図形しか読まないので、素性の知れない & は文字として逃がしてしまってよい
    markup = markup.replace(/&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/g, '&amp;');

    var doc;
    try { doc = new global.DOMParser().parseFromString(markup, 'image/svg+xml'); }
    catch (e){ return null; }
    if (!doc || !doc.documentElement) return null;
    // Chrome/Safari は <parsererror> を埋め込み、Firefox はそれを root にする。両方見る
    if (doc.getElementsByTagName('parsererror').length) return null;
    if (String(doc.documentElement.nodeName).toLowerCase() !== 'svg') return null;

    // live な document へ挿す**前**に落とす。順番が逆だと意味がない。
    // sanitize が先、expandUses が後（clone 経由でスクリプトが復活しないように）
    try { sanitize(doc); expandUses(doc); }
    catch (eS){ if (global.console) global.console.warn('SvgIn: 前処理に失敗', eS); }

    var host = global.document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    // display:none にしてはいけない。getScreenCTM が null を返して viewBox の
    // 変換ごと落ち、配置が壊れる。画面外へ逃がすだけにする
    host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px;height:1200px;overflow:hidden';
    var shapes = [];
    try {
      host.appendChild(global.document.importNode(doc.documentElement, true));
      global.document.body.appendChild(host);
      var list = host.querySelectorAll('path,rect,circle,ellipse,line,polygon,polyline');
      for (var i = 0; i < list.length; i++){
        var el = list[i];
        if (!isRendered(el)) continue;
        var got = shapesFromElement(el);
        for (var j = 0; j < got.length; j++) shapes.push(got[j]);
      }
    } catch (e3){
      // 黙って null を返すと「貼っても何も出ない」だけになって原因が追えない
      if (global.console) global.console.warn('SvgIn: 取り込みに失敗', e3);
      shapes = [];
    } finally {
      // 例外が出ても必ず消す。残ると次回以降の getScreenCTM が別の要素を拾う
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    // NaN を含む形は写した先で線が消えるだけなので、ここで落とす
    shapes = shapes.filter(function(sh){
      return sh.segs.length && sh.segs.every(function(s){
        var ps = s.type === 'L' ? [s.a, s.b] : [s.p0, s.p1, s.p2, s.p3];
        return ps.every(function(p){ return isFinite(p[0]) && isFinite(p[1]); });
      });
    });
    if (!shapes.length) return null;
    return normalize(shapes);
  }

  global.SvgIn = {
    parse: parse,
    // 以下は _test/svgin-test.js から叩く純関数（DOM に依存しない部分）
    _numbers: readNumbers,
    _parseD: parseD,
    _quadToCubic: quadToCubic,
    _arcToCubics: arcToCubics,
    _applyMatrix: applyMatrix,
    _matMul: matMul,
    _mapSegs: mapSegs,
    _rectSegs: rectSegs,
    _bounds: boundsOf,
    _normalize: normalize
  };
})(window);
