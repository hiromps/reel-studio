# カットごとのキーフレームズーム

GUIのカット一覧（絵コンテ）で各カードの「ズーム」を開くか、カットを選んでインスペクタの「キーフレームズーム」を開きます。なし／ズームイン／ズームアウト、強さ1.05〜1.50倍、イージング、アンカーX/Y、開始・終了倍率を編集できます。アンカーは左上が(0, 0)、右下が(1, 1)です。

「ズーム設定を全カットに適用」は選択中（未選択なら先頭）の設定をコピーします。「viral_zoom を一括適用」は先頭1.45倍、3カットのpushと1カットのpullを繰り返します。通常のpushは1.15〜1.20倍で少しずつ強さを変えます。同方向は最大3連続、すべてin_out、アンカー(0.5, 0.45)です。乱数を使わないため同じ順序で毎回同じ結果になります。いずれもCtrl+Zで取り消せます。編集後は通常どおり保存してください。

CLIでは既存のJSON設定に合わせています。

```powershell
npm run reel -- render --project my-shop --zoom-preset viral_zoom
npm run reel -- draft --project my-shop --zoom-config zoom.json
npm run reel -- render --project my-shop --zoom-preset viral_zoom --zoom-config zoom.json
```

`zoom.json`の例（個別指定がプリセットより優先）：

```json
{
  "cuts": {
    "c01": {
      "mode": "push",
      "scale_start": 1.0,
      "scale_end": 1.45,
      "ease": "in_out",
      "anchor_x": 0.5,
      "anchor_y": 0.45
    },
    "c02": {"mode": "pull", "scale_start": 1.2, "scale_end": 1.0},
    "c03": {"mode": "none"}
  }
}
```

キーは`cut.id`。IDのないカットだけは1始まりの番号文字列（`"1"`など）を使います。未知のキーはエラーです。未指定カットはプリセット、プリセットもなければ保存済み設定を使います。CLIオプションは`cuts.json`を書き換えず、書き出し用JSONを`.studio/logs/zoom-props-*.json`に残します。GUIでも再利用する設定は`cuts.json`の各カットの`zoom`に同じオブジェクトを保存します。

開始・終了倍率は1.0〜1.5。pushは終了≧開始、pullは開始≧終了。省略時はpush=1→1.18、pull=1.2→1、ease=`in_out`、anchor=(0.5, 0.5)です。`none`と設定なしは既存の描画を使います。

## 描画方式と制限

既存の処理はRemotionのSequenceで切り出しと結合を行い、映像の上へテロップを合成します。本機能もSequence内のローカルフレームを使い、小数精度のCSS変換で映像レイヤーだけをズームします。ffmpeg zoompanの整数切り出しや中間動画の再エンコードを加えず、GUIプレビューとレンダーで同じ式を使用する方針です。映像の切り出し→ズーム→Sequenceで連結→固定テロップ合成の順で、元の音声・倍速・ナレーション合成・出力設定を維持します。

Sequence内でのフレーム番号の仕様は[Remotion公式ドキュメント](https://www.remotion.dev/docs/use-current-frame)を参照しています。

`n = max(1, round((outSec-inSec)/playbackRate*fps))`、`p=i/(n-1)`。1フレームのカットは開始倍率だけを使用します。in_outは`0.5-0.5*cos(PI*p)`、outは`sin(PI/2*p)`、linearは`p`です。最終フレームで終了倍率に達します。アンカーはズーム中ずっと画面内の同じ位置に固定されます。

既存の静的`crop`がある場合、その切り出しに追加してズームします。実効最大倍率は`crop.zoom * max(scale_start, scale_end)`となり、解像度警告もこれを考慮します。元素材・プロキシの回転を考慮した解像度が出力サイズ×実効最大倍率に足りなければ`ZOOM_RESOLUTION`警告を表示します。本番は1080×1920、ドラフトは270×480で判定します。GUIの検証欄は本番サイズを基準に表示します。補間によって不足する細部を復元することはできません。

対応するのは同梱のstandardエンジンです。旧instagram/yuiエンジンはズームを黙って無視せず、書き出し前にエラーを返します。実フレーム数が期待値と違う場合も書き出し成功として扱いません。GUIの素材サムネイルはカット頭の素材画像で、動くズームの確認にはPlayerを使います。

## 検証

```powershell
npm run typecheck
npm test -- test/zoom.test.ts test/zoom-ui.test.ts test/zoom-engine.test.ts test/zoom-preflight.test.ts
$env:REEL_ZOOM_RENDER_TEST='1'
npm test -- test/zoom-render.test.ts
Remove-Item Env:REEL_ZOOM_RENDER_TEST
```

実レンダー検証にはengineの依存、Remotion用ブラウザ、ffmpeg/ffprobeが必要です。23フレームの合成素材からbaseline／none／push／pullを書き出し、フレーム数・1080×1920・30fps・音声の一致とnoneの画素互換を確認します。先頭・中央・末尾PNGと比較タイルは`.runtime/zoom-check-*/out/`、結果の場所は`.runtime/last-zoom-test.json`に保存します。

## 変更ファイル

- 保存・設定・警告：`shared/schema/cuts.ts`、`shared/schema/zoom.ts`、`shared/zoom.ts`、`shared/validate.ts`
- 描画・CLI：`engine/src/zoom.ts`、`engine/src/GourmetReel.tsx`、`core/render.ts`、`cli/reel.ts`
- GUI：`src/components/ZoomControls.tsx`、`src/components/Storyboard.tsx`、`src/editor/EditorPage.tsx`、`src/editor/Inspector.tsx`、`src/styles.css`
- テスト：`test/zoom.test.ts`、`test/zoom-ui.test.ts`、`test/zoom-engine.test.ts`、`test/zoom-preflight.test.ts`、`test/zoom-render.test.ts`
- 説明書：`docs/cut-zoom.md`
