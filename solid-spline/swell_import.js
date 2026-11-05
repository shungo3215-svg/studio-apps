/* ============================================================================
   swell_import.js — 「線幅の抑揚」の書き出しSVGの封筒（params）を、立体スプラインが
   B スプラインの当てはめに使える点列 [x,y,z,w] へ変換する（DOM非依存の純関数のみ）。
   Outline/Profile/Depth/parseD は呼び出し側から deps で受け取る（循環依存を避けるため。
   bspline.js/depth.js/outline.js/profile.js と同じ UMD 形。ブラウザ（グローバル
   SwellImport）と node（module.exports）両方で読める）。

   幅・奥行きの計算は「線幅の抑揚」index.html の computeProjection/interpAt/
   linkedDepthPctArray と同じ式をそのまま使う（重複実装ではなく、同じ式を書き写した
   もの。線幅の抑揚のDOM依存コードは呼べないため式だけ移植する）。
   ========================================================================== */
(function (root, factory) {
  var SwellImport = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = SwellImport;
  if (root) root.SwellImport = SwellImport;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* パス上の位置t（弧長パラメータ0..1）における(x,y)を、flattenClosedPathExの密点列
     dense（弧長パラメータts・同じ長さ）から線形補間で取る。resamplePathEven（bspline.js）
     と同じ考え方（元点列の間を弧長比で補間するだけ。新しい曲率情報は増やさない）。 */
  function posAtT(dense, ts, target) {
    var m = dense.length;
    if (m === 0) return [0, 0];
    if (m === 1) return [dense[0][0], dense[0][1]];
    var j = 0;
    while (j < m - 1 && ts[j + 1] <= target) j++;
    var t0 = ts[j], t1 = (j + 1 < m) ? ts[j + 1] : 1;
    var p0 = dense[j], p1 = (j + 1 < m) ? dense[j + 1] : dense[0];
    var span = t1 - t0;
    var u = span > 1e-12 ? (target - t0) / span : 0;
    return [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u];
  }

  function bboxLongSide(pts) {
    if (!pts || !pts.length) return 1;
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var w = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    var h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    return Math.max(w, h, 1);
  }

  /* sampleSwell(params, deps, count) → [[x,y,z,w] …]（弧長等間隔count点）
     params: exportMeta().paramsと同じ形（basePath/baseWidth/points/interp/
             depthPoints/interpD/depthLinked/depthInvert/depthSpanPct）。
     deps: { Outline, Profile, Depth, parseD }
           parseD(d) → {segs, closed}（bspline.js の parsePathD と同じ契約）。 */
  function sampleSwell(params, deps, count) {
    params = params || {};
    var Outline = deps.Outline, Profile = deps.Profile, Depth = deps.Depth, parseD = deps.parseD;
    var n = Math.max(1, count | 0);

    var parsed = null;
    try { parsed = parseD(params.basePath); } catch (e) { parsed = null; }
    var segs = (parsed && parsed.segs) || [];
    var ex = Outline.flattenClosedPathEx(segs, 0.25, 4);
    var dense = ex.pts;
    if (!dense || dense.length < 3) return [];
    var param = Outline.arcLengthParam(dense);
    var ts = param.ts;

    // --- 幅: sorted points で interp が 'bspline' かつ3点以上ならProfile.bsplineClosed、
    //     それ以外はOutline.widthAtSmooth（線幅の抑揚 interpAt と同じ分岐）。
    var sortedW = (params.points || []).slice().sort(function (a, b) { return a.t - b.t; });
    var wTs = sortedW.map(function (p) { return p.t; });
    var wLeft = sortedW.map(function (p) { return p.left; });
    var wRight = sortedW.map(function (p) { return p.right; });
    var useBsplineW = params.interp === 'bspline' && sortedW.length >= 3;
    var baseWidth = params.baseWidth != null ? params.baseWidth : 6;
    function widthAt(t) {
      if (useBsplineW) return { left: Profile.bsplineClosed(wLeft, wTs, t), right: Profile.bsplineClosed(wRight, wTs, t) };
      return Outline.widthAtSmooth(sortedW, t, baseWidth);
    }

    // --- longSide: samples（denseな平坦化点列）のbbox長辺（線幅の抑揚 shapeBBoxLongSideと同じ）。
    var longSide = bboxLongSide(dense);
    var spanFactor = (params.depthSpanPct != null ? params.depthSpanPct : 60) / 100;

    var out = [], wAll = [];
    for (var i = 0; i < n; i++) {
      var t = i / n;
      var p = posAtT(dense, ts, t);
      var wv = widthAt(t);
      var w = wv.left + wv.right;
      out.push([p[0], p[1], 0, w]);
      wAll.push(w);
    }

    // --- 奥行き（%→px）: depthLinkedならDepth.linkedDepth(各サンプルのw, depthInvert)。
    //     falseならdepthPointsを{t,left:z,right:z}にして幅と同じ補間（interpD）でleftを取る。
    if (params.depthLinked) {
      var pctArr = Depth.linkedDepth(wAll, !!params.depthInvert);
      for (var k = 0; k < n; k++) out[k][2] = (pctArr[k] / 100) * spanFactor * longSide;
    } else {
      var depthPts = (params.depthPoints || []).map(function (p) { return { t: p.t, left: p.z, right: p.z }; });
      var sortedD = depthPts.slice().sort(function (a, b) { return a.t - b.t; });
      var dTs = sortedD.map(function (p) { return p.t; });
      var dLeft = sortedD.map(function (p) { return p.left; });
      var useBsplineD = params.interpD === 'bspline' && sortedD.length >= 3;
      for (var k2 = 0; k2 < n; k2++) {
        var t2 = k2 / n;
        var pct = useBsplineD ? Profile.bsplineClosed(dLeft, dTs, t2) : Outline.widthAtSmooth(sortedD, t2, 0).left;
        out[k2][2] = (pct / 100) * spanFactor * longSide;
      }
    }

    return out;
  }

  return {
    posAtT: posAtT,
    bboxLongSide: bboxLongSide,
    sampleSwell: sampleSwell
  };
});
