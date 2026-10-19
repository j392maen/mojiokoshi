# mojiokoshi

**Drop sound, keep words.** — 音声・動画ファイルをウィンドウにドロップすると、**同じフォルダに同じ名前の `.txt`** として文字起こしを書き出すデスクトップアプリです。

```
C:\Lectures\半導体01_1.mp4  →  C:\Lectures\半導体01_1.txt
```

- ローカル完結（音声を外部に送信しません）。初回のモデル取得後はオフラインで動作
- GPU（CUDA）を自動で使用し、使えない環境では CPU に自動フォールバック
- 46分の講義動画を約100秒で処理（RTX 4060 Laptop / 約28倍速）
- 言語は自動判定。日本語・中国語は句読点付きで出力

## セットアップ

前提：Windows 10/11、Python 3.10 以上（WebView2 ランタイムは Windows 11 に標準搭載）

1. `setup.bat` をダブルクリック（仮想環境を作成し、依存ライブラリと CUDA ランタイムをインストール。約3GB）
2. `mojiokoshi.bat` をダブルクリックで起動

初回起動時に音声認識モデル（`large-v3-turbo`、約1.6GB）を自動でダウンロードします。進捗は画面上部に表示されます。

## 使い方

| 方法 | 操作 |
| --- | --- |
| ウィンドウ | ファイル（複数可）やフォルダをウィンドウにドロップ。または「ファイルを選ぶ」/ `Ctrl+O` |
| バッチファイル | ファイルを `mojiokoshi.bat` のアイコンに直接ドロップ（ウィンドウなしで処理） |
| コマンドライン | `.venv\Scripts\python -m mojiokoshi a.mp4 b.wav [--language ja] [--device cpu] [--model large-v3]` |

**対応形式：** mp4 mov mkv webm avi m4v / wav mp3 m4a aac flac ogg opus wma

**出力仕様：** UTF-8 のプレーンテキスト、1発話1行。同名の `.txt` が既にある場合は上書きします（一時ファイルに書いてから置き換えるため、途中で失敗しても壊れたファイルは残りません）。

完了後は、波形にマウスを重ねるとその時点の発言が表示され、クリックすると該当行へジャンプします。

## 構成

```
mojiokoshi/
├─ mojiokoshi/          Python パッケージ
│  ├─ engine.py         faster-whisper の取得・ロード・推論（GPU→CPU フォールバック）
│  ├─ media.py          PyAV デコード、波形ピーク、対応拡張子
│  ├─ jobs.py           Job / Segment と直列ワーカー
│  ├─ writer.py         .txt の整形と原子的書き込み
│  ├─ gui.py            pywebview ブリッジ（D&D のフルパス取得、タイトルバー配色）
│  ├─ cli.py            ヘッドレス実行
│  └─ web/              UI（HTML / CSS / Canvas、フォント同梱）
├─ docs/DESIGN.md       リサーチ・設計・ER 図
├─ setup.bat / mojiokoshi.bat
└─ requirements.txt
```

設計の詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

## UI の開発

`mojiokoshi/web/index.html?demo=<scene>` をブラウザで開くと、Python なしで各状態を再現できます。
シーン：`idle` `drag` `download` `work` `done` `multi` `error`

`--debug` オプション（または環境変数 `MOJIOKOSHI_DEBUG=1`）で WebView の開発者ツールが有効になります。ログは `%LOCALAPPDATA%\mojiokoshi\mojiokoshi.log` に出力されます。

## ライセンス表記

同梱フォント：Instrument Serif、Geist / Geist Mono、Shippori Mincho（いずれも SIL Open Font License 1.1、`mojiokoshi/web/fonts/` にライセンス同梱）
