/* ============================================================================
   motion.js — 段7-2「動画にする」の純関数群（DOM非依存）。
   角度・深さの始点/終点をイージング・反復モードに沿ってフレームごとの値へ写すだけの
   計算（実際の描画・録画はDOMが要るためindex.html側で行う。150_動きの書き出し/core.jsと
   同じ役割分担）。
   ========================================================================== */
(function (root, factory) {
  var Motion = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Motion;
  if (root) root.Motion = Motion;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp01(u) { return u < 0 ? 0 : (u > 1 ? 1 : u); }
  function smooth(u) { return u * u * (3 - 2 * u); } // smoothstep（両端で傾き0）

  /* イージング。name: 'linear' | 'easeIn'（ゆっくり始まる） | 'easeOut'（ゆっくり終わる）
     | 'easeInOut'（両方）。uは0..1。 */
  function ease(name, u) {
    u = clamp01(u);
    switch (name) {
      case 'easeIn': return u * u; // 加速＝ゆっくり始まる
      case 'easeOut': return 1 - (1 - u) * (1 - u); // 減速＝ゆっくり終わる
      case 'easeInOut': return smooth(u); // 両方
      case 'linear': default: return u;
    }
  }

  function lerp(a, b, u) { return a + (b - a) * u; }

  /* 秒数・fpsからフレーム総数（最低1）。 */
  function frameCount(durationSec, fps) {
    return Math.max(1, Math.round((durationSec || 0) * (fps || 1)));
  }

  /* i番目のフレーム（0始まり・全frameCount枚）の「進み方向の生のu」（0..1、イージング前）。
     mode: 'once'（1回・最終フレームでu=1に達する） | 'pingpong'（往復・0→1→0）
     | 'loop'（ループ・終点で始点へ戻る＝uはframeCountで割ってwrapし、最後のフレームは
     　1のわずか手前で止まる＝終点フレームそのものを重複させない。始点/終点の差が360°の
     　倍数なら見た目の継ぎ目が出ない、という前提はUI側の文言でユーザーに伝える）。 */
  function frameU(i, count, mode) {
    if (count <= 1) return 0;
    if (mode === 'pingpong') {
      var half = count; // 往復は「行き」をcountフレームで作り、「帰り」は呼び出し側が反転して使う想定
      var period = (count - 1) * 2;
      if (period <= 0) return 0;
      var k = i % period;
      return k <= count - 1 ? k / (count - 1) : (period - k) / (count - 1);
    }
    if (mode === 'loop') return (i % count) / count;
    // once（既定）
    return i / (count - 1);
  }

  /* 動画全体のフレーム総数（反復モード込み）。pingpong/loopは同じcount（1周ぶん）を使う設計
     なので、ここではmodeに関わらずframeCount(durationSec,fps)をそのまま返す
     （秒数＝1周の長さ、という素直な定義。往復を秒数の中に収める）。 */
  function totalFrames(durationSec, fps) { return frameCount(durationSec, fps); }

  /* 始点・終点・現在のuから、イージング適用済みの値を返す。 */
  function valueAt(startV, endV, u, easingName) {
    return lerp(startV, endV, ease(easingName, u));
  }

  return {
    ease: ease,
    lerp: lerp,
    frameCount: frameCount,
    frameU: frameU,
    totalFrames: totalFrames,
    valueAt: valueAt
  };
});
