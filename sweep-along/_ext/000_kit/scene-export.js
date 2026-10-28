/*!
 * scene-export.js — Studio共通「シーンJSON（scene/1）」の書き出し・検証だけを持つ小さな部品。
 * 141_動きと空間への展開/scene-json.md の契約に対応する実装。DOM非依存の関数はそのまま
 * node からも読める（tri-grid/test.mjs・motion-space-vessel/test.mjs と同じ流儀）。
 *
 * 契約（scene/1）:
 *   { scene:'1', tool, pj, exportedAt,
 *     box:[x,y,w,h],
 *     style:{ bg:'#hex'|'none' },
 *     shapes:[ {id,color,d} ],   // 見た目の正本（色ごとの融合path）
 *     units:[ {id,layer,color,pts:[[x,y],...]} ], // 動かす最小単位（閉じた多角形）
 *     rule:{ ... },              // 元ツールの規則（器のアダプター用。器v0.1は読むだけ）
 *     meta:{ ... } }             // 元ツールのexportMeta()相当
 *
 * 追加の任意項目（scene/1の旧JSONと互換）:
 *   shapes/units/steps.log[].cells の opacity: 0〜1、省略時1。同じlayerの共通opacityはレイヤーに適用。
 *   colorは出力元でレイヤー固有色・陰影色を解決した実際の塗り色。
 *   playback:{tool:'tsumiki-replay',version:1,params:{order,overlap,lap2,end,hold,interval,skipErase}}
 *   steps.log[].hold は interval 単位、holdSeconds は秒（両方ある場合は後者優先）。
 *
 * 使い方: studio-kit.js の次に <script src="…/000_kit/scene-export.js"> で読み込む。
 * window.Studio があれば Studio.sceneExport / Studio.sceneValidate を足す。
 * 無ければ window.SceneExport に同じ関数を置く（studio-kit未使用のツール向けの逃げ道）。
 */
(function (root, factory) {
  var M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (root) {
    if (root.Studio) {
      root.Studio.sceneExport = M.sceneExport;
      root.Studio.sceneValidate = M.sceneValidate;
    } else {
      root.SceneExport = M;
    }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // scene に scene:'1' と exportedAt を補ったコピーを返す（呼び出し側の元オブジェクトは書き換えない）
  function finalizeScene(scene) {
    var out = Object.assign({}, scene);
    out.scene = '1';
    out.exportedAt = new Date().toISOString();
    return out;
  }

  // {ok:boolean, errors:string[]} を返す（1件も無ければ ok:true）
  function sceneValidate(obj) {
    var errors = [];
    if (!obj || typeof obj !== 'object') { errors.push('シーンJSONがオブジェクトではありません'); return { ok: false, errors: errors }; }
    if (obj.scene !== '1') errors.push('sceneが"1"ではありません');
    if (!Array.isArray(obj.box) || obj.box.length !== 4) errors.push('boxが4要素の配列ではありません');
    var hasUnits = Array.isArray(obj.units) && obj.units.length > 0;
    var hasShapes = Array.isArray(obj.shapes) && obj.shapes.length > 0;
    if (!hasUnits && !hasShapes) errors.push('unitsまたはshapesが1つもありません');
    if (hasUnits) {
      obj.units.forEach(function (u, i) {
        if (!u || !Array.isArray(u.pts) || u.pts.length < 3) errors.push('units[' + i + '].ptsが3点未満です');
        if (u && u.opacity != null && (!Number.isFinite(u.opacity) || u.opacity < 0 || u.opacity > 1)) errors.push('units[' + i + '].opacityが0〜1ではありません');
      });
    }
    if (hasShapes) {
      obj.shapes.forEach(function (shape, i) {
        if (shape && shape.opacity != null && (!Number.isFinite(shape.opacity) || shape.opacity < 0 || shape.opacity > 1)) errors.push('shapes[' + i + '].opacityが0〜1ではありません');
      });
    }
    if (obj.steps && Array.isArray(obj.steps.log)) {
      obj.steps.log.forEach(function (entry, i) {
        (entry && Array.isArray(entry.cells) ? entry.cells : []).forEach(function (cell, j) {
          if (cell && cell.opacity != null && (!Number.isFinite(cell.opacity) || cell.opacity < 0 || cell.opacity > 1)) errors.push('steps.log[' + i + '].cells[' + j + '].opacityが0〜1ではありません');
        });
      });
    }
    if (obj.playback != null) {
      var p = obj.playback && obj.playback.params;
      if (!p || obj.playback.tool !== 'tsumiki-replay' || obj.playback.version !== 1 ||
          ['forward', 'reverse'].indexOf(p.order) === -1 || ['last', 'first'].indexOf(p.overlap) === -1 ||
          ['none', 'flipOverlap', 'flipOrder', 'both'].indexOf(p.lap2) === -1 || ['cut', 'bounce', 'vanish'].indexOf(p.end) === -1 ||
          !Number.isFinite(p.hold) || p.hold < 0 || !Number.isFinite(p.interval) || p.interval <= 0 || typeof p.skipErase !== 'boolean') {
        errors.push('playbackの形式が不正です');
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // scene を <name>.json として書き出す。opts.name は拡張子なし
  function sceneExport(scene, opts) {
    opts = opts || {};
    var finalized = finalizeScene(scene);
    var text = JSON.stringify(finalized, null, 2);
    var name = (opts.name || 'scene') + '.json';
    var blob = (typeof Blob !== 'undefined') ? new Blob([text], { type: 'application/json' }) : null;
    if (typeof self !== 'undefined' && self.Studio && typeof self.Studio.dl === 'function' && blob) {
      self.Studio.dl(blob, name);
    } else if (typeof document !== 'undefined' && blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }
    return finalized;
  }

  return { sceneExport: sceneExport, sceneValidate: sceneValidate, finalizeScene: finalizeScene };
});
