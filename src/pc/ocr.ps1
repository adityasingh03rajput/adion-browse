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
$file = $null
$stream = $null
try {
  $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { [Console]::Error.WriteLine('no OCR language installed'); exit 2 }
  $result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  if ($Mode -eq 'words' -or $Mode -eq 'json' -or $Mode -eq 'lines') {
    $wordList = New-Object System.Collections.Generic.List[Object]
    $lineList = New-Object System.Collections.Generic.List[Object]
    if ($result.Lines) {
      foreach ($line in $result.Lines) {
        $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = 0; $maxY = 0
        if ($line.Words) {
          foreach ($w in $line.Words) {
            $rect = $w.BoundingRect
            $wx = [int][Math]::Round($rect.X)
            $wy = [int][Math]::Round($rect.Y)
            $ww = [int][Math]::Round($rect.Width)
            $wh = [int][Math]::Round($rect.Height)
            if ($wx -lt $minX) { $minX = $wx }
            if ($wy -lt $minY) { $minY = $wy }
            if (($wx + $ww) -gt $maxX) { $maxX = ($wx + $ww) }
            if (($wy + $wh) -gt $maxY) { $maxY = ($wy + $wh) }
            $wordList.Add(@{
              text = $w.Text
              x = $wx
              y = $wy
              w = $ww
              h = $wh
            })
          }
        }
        if ($minX -lt [int]::MaxValue -and $line.Text) {
          $lineList.Add(@{
            text = $line.Text
            x = $minX
            y = $minY
            w = [Math]::Max(1, $maxX - $minX)
            h = [Math]::Max(1, $maxY - $minY)
          })
        }
      }
    }
    $obj = @{
      text = $result.Text
      lines = $lineList
      words = $wordList
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $obj -Compress -Depth 4))
  } else {
    [Console]::Out.Write($result.Text)
  }
} finally {
  if ($stream) {
    try { $stream.Dispose() } catch {}
  }
}
