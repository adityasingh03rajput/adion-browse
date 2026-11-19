param(
  [string]$Out = "screen.png"
)
# Standalone whole-screen screenshot (all monitors = virtual screen).
# No dependencies beyond .NET:  powershell -File screen-shot.ps1 -Out screen.png
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally { $g.Dispose() }
  $full = [System.IO.Path]::GetFullPath($Out)
  $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
  $monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    @{ device=$_.DeviceName; primary=$_.Primary; bounds=@{ x=$_.Bounds.X; y=$_.Bounds.Y; w=$_.Bounds.Width; h=$_.Bounds.Height } }
  })
  @{ ok=$true; file=$full; virtualScreen=@{ x=$vs.X; y=$vs.Y; w=$vs.Width; h=$vs.Height }; monitors=$monitors } | ConvertTo-Json -Depth 5 -Compress
} finally { $bmp.Dispose() }
