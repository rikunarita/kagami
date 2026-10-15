# KAGAMI 動作検証レポート

検証日: 2026-10-15 / 環境: Debian 12 (bookworm), Chromium 155.0.8059.39, Node v26.12.0 (Current) / pnpm 12.11.2 / Vite 8.3.4, 2 vCPU / 1 GB RAM
サンプル: `assets/sample.html` (日本語テキスト + grid + gradient + border、1280 px 幅で 1280×898)

## 1. ヘッドレスパイプライン検証 (`npm run test:node`)

Satoru レンダリング → jSquash デコード → 候補エンコード → デコード突合 の全段を Node で実測。
可逆モードは**元画像とのピクセル完全一致 (exact=true)** を合格条件とする。

| 段階                     | 結果                          |
| ------------------------ | ----------------------------- |
| Satoru SVG (text→paths)  | 3,304 ms / 606,195 B          |
| Satoru PNG (Skia raster) | 805 ms / 148,508 B / 1280×898 |

| 形式 / モード   | 候補 (bytes / exact / PSNR dB)                                                             | 採用       |
| --------------- | ------------------------------------------------------------------------------------------ | ---------- |
| PNG 可逆        | squoosh png 263,183 / exact / ∞ ・ **oxipng L6 90,519 / exact / ∞**                        | oxipng L6  |
| WebP 可逆       | **libwebp lossless m6 exact 54,750 / exact / ∞** ・ libwebp lossless m6 54,750 / exact / ∞ | exact 変種 |
| AVIF 可逆       | **libavif lossless s0 187,880 / exact / ∞**                                                | s0         |
| JPEG 非可逆 q85 | **mozjpeg qt3+trellis 66,854 / 38.1** ・ mozjpeg qt2 71,112 / 39.7                         | qt3        |
| WebP 非可逆 q85 | **libwebp m6 p1 46,736 / 41.2** ・ m6 p6 sharp-yuv 49,748 / 40.5                           | m6 p1      |
| AVIF 非可逆 q85 | avif s2 42,861 / 42.7 ・ **avif s2 cdq+sharp-yuv 40,386 / 43.2**                           | cdq        |

結論: 可逆は全形式でピクセル完全一致を検証。非可逆は同一品質でより小さい候補を自動採用(候補間で最大 -5.8%)。

## 2. ブラウザ E2E 検証 (`npm run test:e2e`, 実 Chromium)

### フェーズ A — 並列レンダリングとレイアウト再利用 (`?workers=2`)

| 項目                                | 実測                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| ワーカープール統計 (プレビュー直後) | workerCount 2 / completedJobs 2 (SVG pass + Skia pass 同時) / avg 1,802 ms |
| 幅変更 (800 px) 時の経路            | `LAYOUT REUSE` (再パースなし、約 0.4 s)                                    |

### フェーズ B — 形式×モード行列 (ダウンロード文件的検証)

| シナリオ               | サイズ    | 所要   | マジックバイト | 検証                            |
| ---------------------- | --------- | ------ | -------------- | ------------------------------- |
| PNG 可逆 (高)          | 81,896 B  | 16.7 s | OK             | LOSSLESS VERIFIED (pixel-exact) |
| WebP 可逆 (高)         | 49,634 B  | 6.4 s  | OK             | LOSSLESS VERIFIED (pixel-exact) |
| AVIF 可逆 (標準)       | 159,724 B | 13.2 s | OK             | LOSSLESS VERIFIED (pixel-exact) |
| JPEG 非可逆 q85 (高)   | 57,981 B  | 1.1 s  | OK             | PSNR 37.03 dB                   |
| WebP 非可逆 q85 (高)   | 39,786 B  | 0.9 s  | OK             | PSNR 40.46 dB                   |
| AVIF 非可逆 q85 (標準) | 33,890 B  | 10.9 s | OK             | PSNR 42.15 dB                   |
| SVG 可逆               | 605,593 B | 0.1 s  | OK             | 構造保存ミニファイ              |

コンソールエラー: **0 件** / ページエラー: **0 件** / 全ダウンロードのマジックバイト一致。
スクリーンショット: `docs/screenshots/preview.png`, `docs/screenshots/encoded.png`, `docs/screenshots/telemetry.png`

## 3. 検証中に発見し修正した問題 (抜粋)

1. worker-lib の転送 semantics によりフォントバッファが detach される → ジョブごとにクローン。
2. 複数ワーカーの同時コールド WASM 起動がハング → 起動時逐次プレウォーム(コーデックワーカーも同様)。
3. emscripten glue は構造体の全フィールドを要求 → コーデック既定値をマージしてから呼出。
4. デコーダ引数数が形式ごとに異なる (webp=1 / jpeg,avif=2) → 形式別ディスパッチ。
5. `[hidden]` が `display:flex/row` に負けて要素が残る → `[hidden]{display:none!important}`。
6. Satoru のフォントマップ未知スキーム挙動 → `kagami:` 内部スキームと ResolvedFontResult で自前解決(ネットワーク不要)。

## 4. 既知の制限

- JPEG に数学的可逆モードは存在しないため、UI で明示し非可逆のみ提供。
- PNG 非可逆は一律量子化前処理(スライダー連動)として実装。
- AVIF 可逆 speed 0(極限)は 1280×898 で約 30 s。標準努力量では speed 4 に緩和。
- 1 GB RAM 環境ではワーカー数 2 が実用上の上限(それ以上は `?workers=N` / 設定欄で任意指定可)。
