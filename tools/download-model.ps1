# 把语音识别模型下载到扩展源码目录的 src\models\ 下 —— 之后扩展从磁盘直读权重，
# 不再走浏览器缓存（C 盘），模型随项目文件夹存放在你指定的盘符。
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File tools/download-model.ps1              # 默认：turbo 模型 + fp16(GPU) + q8(CPU兜底) 权重
#   powershell -ExecutionPolicy Bypass -File tools/download-model.ps1 -Dtypes fp16 # 只下 GPU 权重（体积最小）
#   powershell -ExecutionPolicy Bypass -File tools/download-model.ps1 -Dtypes fp16,quantized,q4
#   powershell -ExecutionPolicy Bypass -File tools/download-model.ps1 -Repo onnx-community/whisper-base -Dtypes quantized
param(
  [string]$Repo = 'onnx-community/whisper-large-v3-turbo',
  [string[]]$Dtypes = @('fp16', 'quantized'),
  [string]$Source = ''   # 留空自动探测：huggingface.co 优先，不通则 hf-mirror.com
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # 项目根目录（tools/ 的上一级）
$dest = Join-Path $root ("src\models\" + $Repo)
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'onnx') | Out-Null

# ---- 选源：两个源都试，谁先下成功 config.json 用谁 ----
if (-not $Source) {
  foreach ($h in @('https://huggingface.co', 'https://hf-mirror.com')) {
    Write-Host "探测下载源 $h ..." -ForegroundColor DarkGray
    & curl.exe -sL --max-time 20 --retry 1 -o "$env:TEMP\ytl-probe.json" "$h/$Repo/resolve/main/config.json"
    if ($LASTEXITCODE -eq 0 -and (Test-Path "$env:TEMP\ytl-probe.json") -and (Get-Item "$env:TEMP\ytl-probe.json").Length -gt 100) {
      $Source = $h; break
    }
  }
  if (-not $Source) { Write-Host "两个下载源都不可达（检查网络/代理）" -ForegroundColor Red; exit 1 }
}
Write-Host "下载源：$Source" -ForegroundColor Cyan
Write-Host "保存到：$dest" -ForegroundColor Cyan

# ---- 文件清单：配置/分词器（小文件全下） + 按 dtype 选权重 ----
$configFiles = @('config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt',
  'added_tokens.json', 'special_tokens_map.json', 'normalizer.json')
# dtype → onnx 文件名（与 transformers.js 的请求命名一致，2026-08 按 HF 仓库实际清单核对）
$dtypeMap = @{
  'fp16'       = @('encoder_model_fp16.onnx', 'decoder_model_merged_fp16.onnx')
  'quantized'  = @('encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx')   # 即 q8
  'q4'         = @('encoder_model_q4.onnx', 'decoder_model_merged_q4.onnx')
  'fp32'       = @('encoder_model.onnx', 'encoder_model.onnx_data', 'decoder_model_merged.onnx')
}
$weightFiles = @()
foreach ($d in $Dtypes) {
  if ($dtypeMap[$d]) { $weightFiles += $dtypeMap[$d] }
  else { Write-Host "未知 dtype '$d'（可选：fp16 / quantized / q4 / fp32）" -ForegroundColor Red; exit 1 }
}

function Get-File($rel) {
  $out = Join-Path $dest $rel
  $url = "$Source/$Repo/resolve/main/$rel"
  if ((Test-Path $out) -and (Get-Item $out).Length -gt 0) {
    Write-Host "  已存在，跳过 $rel" -ForegroundColor DarkGray; return
  }
  Write-Host "  下载 $rel" -ForegroundColor Yellow
  & curl.exe -L --retry 3 -C - --retry-delay 2 -o "$out" "$url"
  if ($LASTEXITCODE -ne 0) { Write-Host "  失败：$rel（可重跑脚本断点续传）" -ForegroundColor Red }
}

Write-Host "`n[1/2] 配置与分词器文件" -ForegroundColor Cyan
foreach ($f in $configFiles) { Get-File $f }
Write-Host "`n[2/2] 模型权重（$($Dtypes -join ' + ')）" -ForegroundColor Cyan
foreach ($f in $weightFiles) { Get-File ("onnx/" + $f) }

$sz = (Get-ChildItem $dest -Recurse -File | Measure-Object -Sum Length).Sum / 1MB
Write-Host ("`n完成：{0:N0} MB → {1}" -f $sz, $dest) -ForegroundColor Green
Write-Host "最后一步：chrome://extensions 重新加载扩展，启动识别时状态栏会显示" -ForegroundColor Green
Write-Host "        「本地权重」字样即生效（不再下载、不占 C 盘浏览器缓存）。" -ForegroundColor Green
