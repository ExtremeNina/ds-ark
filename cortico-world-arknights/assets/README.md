# PaddleOCR model

2026/06/12

from <https://www.paddleocr.ai/main/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html>

## det model

PP-OCRv6_small_det  
PP-OCRv6 的 small 档文本检测模型，面向移动端/桌面端的速度与精度平衡场景。

## rec model

PP-OCRv6_small_rec  
PP-OCRv6 的 small 档文本识别模型，支持简体中文、繁体中文、英文、日文及 46 种拉丁语系语言。

## rec label

from `PP-OCRv6_small_rec_onnx_infer.tar/inference.yml`

## 放置位置

`det.onnx`、`rec.onnx`、`keys.txt` 必须平铺在 `assets/resource/model/ocr/` 下。MaaFramework 只按这三个
固定文件名查找，不会进入子目录；多套一层目录会在识别阶段表现为 0 行。

## 许可

模型来自 PaddleOCR（Apache-2.0），ONNX 转换由
[MaaCommonAssets](https://github.com/MaaXYZ/MaaCommonAssets)（MIT）提供。
