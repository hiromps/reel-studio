# グルメ動画の共通カットJSON

案件内の `reel-cuts.json` を、編集・台本・音声生成の共通データにします。トップレベルは **カットの配列** です。既存案件は自動移行せず、このファイルを取り込んだ案件だけ共通方式になります。

型・Zodスキーマは `shared/schema/reel-cuts.ts`、初期値とFish変換設定は `shared/config/oc-eat.json`、入力例は `shared/config/oc-eat-example.json` です。初期設定は調整用の出発点です。@oc.eat の実動画から分析した値ではありません。

```json
[
  {
    "id": "dish-1",
    "slot": "dish",
    "clip_path": "uploads/dish.mp4",
    "start": 0.5,
    "duration": 3,
    "line": "このお肉、とろけます！",
    "intensity": 4,
    "emotion_tag": "excited",
    "speed": 1.1,
    "pause_after": 0.2,
    "emphasis": ["とろけます"]
  }
]
```

| フィールド | 意味と検証 |
| --- | --- |
| `slot` | `self_eat / shop_highlight / dish / crowd / entrance / serve / sizzle / eating / interior / exterior` |
| `clip_path` | 案件の `public/` からの相対パス、または設定済みローカル素材領域内の絶対パス。URL・data URL・UNC・`..` は拒否 |
| `start` | 元素材内の開始秒。0以上の有限数 |
| `duration` | 完成動画上のカット秒数。正の有限数。再生速度を変えても完成尺の意味は同じ |
| `line` | ナレーション本文。空文字ならそのカットは音声なし |
| `intensity` | 強さ1〜5の整数。旧形式の角括弧タグでは従来の変換を保持。固定タグは強さの自動タグより優先 |
| `emotion_tag` | `emotion_tags.json` のタグID文字列。タグなしは `null`。旧形式の角括弧文字列も互換として読める |
| `speed` | 1.0基準の話速。公式API範囲0.5〜2.0 |
| `pause_after` | カット末尾で最低限確保するナレーションなしの秒数。次のカットは `duration` 後に開始。短い音声では間がこれより長くなる |
| `emphasis` | 強調語の配列。各語は `line` に存在する必要がある |
| `id` | 省略可。保存時に一度だけ割り当てる固定ID。並べ替え後もWAVとの対応を保持 |
| `editor` | 任意。既存の `crop / zoom / color / playbackRate / main / price / badge / subs` を保持 |

`pause_after` は `duration` 以下、台詞がある場合は `duration` より短くします。音声は `duration - pause_after` の枠でトリミングし、長すぎる生成音声には警告します。語尾が切れる場合はカット尺・話速・本文を調整してください。Fishに正確な秒数の休止パラメータを推測して送りません。

小数秒のカット尺は動画のfpsに合わせてフレーム単位で丸めます。音声配置と台本の時刻も同じ丸めを使い、カット数が増えても映像と音声の開始位置がずれないようにします。JSONの指定値は保持します。丸め後に発話枠がなくなる設定は保存時にエラーにします。

## 保存・読み込み

先に通常どおり案件を作り、素材をローカルに取り込みます。例の `clip_path` を実際の素材名に合わせてください。

```powershell
npm run reel -- cuts validate --file shared/config/oc-eat-example.json
npm run reel -- cuts import --file my-reel.json --project shop-reel
npm run reel -- cuts show --project shop-reel
npm run reel -- cuts script --project shop-reel
```

`validate` はデータの型・値を検証します。`import` では素材の存在・保存範囲も検証し、原本の共通JSONと互換用 `cuts.json / narration.json` を保存します。上書き前のJSONは `.studio/backups/` に残ります。既存案件の取り込みは台詞も含めて入力配列を採用するため、入力内容を確認してください。

ローカル・クラウド共通のAPI:

- `GET /api/projects/:slug/reel-cuts` → `{etag, data, config}`
- `PUT /api/projects/:slug/reel-cuts` → 本文は配列そのもの。更新時は取得した `etag` を `If-Match` に指定。競合409、検証エラー400
- 従来の `/files/cuts`、`/files/narration`、`/script` からの保存も共通配列に戻す

既存の編集画面で切り出し・並び・色・テロップを編集できます。ナレーション画面の本文・ボイスも利用できます。感情は編集画面の「感情タグ」で選べます（[固定感情タグ](emotion-tags.md)）。強さ・話速・間・強調語は共通JSONまたはAPIで変更します。

共通案件の台本画面は配列から作った台本を表示します。各 `ナレーションJSON: "本文"` の文字列を編集できます。カットID、見出し、順序を維持してください。従来の自由文台本によるAI構成の置き換えは止め、共通データとの二重管理を防ぎます。構成変更は編集画面または共通JSONで行います。音声の配置・発話枠もカット尺と `pause_after` を使って変更します。

保存後も共通JSONが原本です。互換用JSONを外部エディターで直接変更しても共通配列へ逆反映しません。必ずアプリの保存APIを使うか、`reel-cuts.json` を編集してください。初回は `import` でIDを割り当て、以降はIDを保持します。

## JSON設定

コードを変えずに調整する場合:

```powershell
npm run reel -- cuts config --out C:/ReelStudio/config/oc-eat.json
$env:REEL_STUDIO_OC_EAT_CONFIG = 'C:/ReelStudio/config/oc-eat.json'
```

環境変数を指定しない場合も、設定フォルダ（通常 `~/.reel-studio/`、`REEL_STUDIO_HOME` で変更可）に `oc-eat.json` があれば読み込みます。どちらもない場合だけ同梱JSONを使います。不正な設定を黙って無視しません。呼び出しごとに読み直すため、調整後の再ビルドは不要です。

`defaults` は新規カットの初期値です。保存済み配列には値が明記されるため、既存カットを一括変更する場合は配列も更新してください。`fish.intensity_tags / emphasis_tag / volume / chunk_length / normalize` は生成時に参照します。話速や強さの値は実際の声を聴いて調整してください。

## ローカル保存・キャッシュ・クラウド

素材・WAV・MP4はローカルの既存保存設定を使います。絶対パスの原本は案件の `public/uploads/reel-cuts/` に一度だけハードリンクし、非対応の場合だけコピーします。同じ原本の参照を繰り返し作りません。保存範囲は既存設定の `uploadsRoot / workDir / REEL_STUDIO_MEDIA_ROOT` などです。

生成音声は `narration/oc_<id>.wav` に保存します。本文・感情・強調・強さ・速度・ボイス・モデル・生成設定とWAVの状態を照合し、変更された音声だけ再生成します。並べ替えや間の調整だけなら再利用します。古い音声のままのmix・納品を防ぎます。Fish APIキーはキャッシュに保存しません。

クラウドでは共通配列を docs の `reelCuts` として同期します。クラウド画面からの編集は共通配列と互換ドキュメントを同一DBトランザクションで更新します。DBのテーブル追加は不要です。素材の実体はPCのワーカーだけが読み書きし、Supabase Storageの利用はありません。クラウドで新しい素材パスを指定する場合、そのPCに実ファイルが必要です。生成用のカスタム設定JSONはPC上に置きます。

## Fish Audioの確認元

2026-10-21に公式ドキュメントを確認しました。

- [TTS API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech): `POST /v1/tts`、`reference_id`、`prosody.speed`、WAV出力
- [公式OpenAPI](https://github.com/fishaudio/docs/blob/main/api-reference/openapi.json): 話速の0.5〜2.0、リクエストの型
- [Emotion Control](https://docs.fish.audio/developer-guide/core-features/emotions): S2の角括弧タグ、語の前の `[emphasis]`、自然言語による強さ

対応モデルは設定の `supported_models` に明記します。現在の共通カットTTSはS2用です。`intensity / emphasis / pause_after` という未定義APIフィールドは送りません。自動テストは送信形式をモックで検証します。実APIでの聞き比べは「感情タグ」の試聴ボタンで行えます。
