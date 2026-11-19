param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $false)][string]$Mode = 'text'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { [Console]::Error.WriteLine('no OCR language installed'); exit 2 }
$result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

if ($Mode -eq 'words' -or $Mode -eq 'json') {
  $wordList = New-Object System.Collections.Generic.List[Object]
  if ($result.Lines) {
    foreach ($line in $result.Lines) {
      if ($line.Words) {
        foreach ($w in $line.Words) {
          $rect = $w.BoundingRect
          $wordList.Add(@{
            text = $w.Text
            x = [int][Math]::Round($rect.X)
            y = [int][Math]::Round($rect.Y)
            w = [int][Math]::Round($rect.Width)
            h = [int][Math]::Round($rect.Height)
          })
        }
      }
    }
  }
  $obj = @{
    text = $result.Text
    words = $wordList
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject $obj -Compress -Depth 4))
} else {
  [Console]::Out.Write($result.Text)
}

$stream.Dispose()
