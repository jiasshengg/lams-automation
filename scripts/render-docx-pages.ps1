# Saves Word documents as PDF with Microsoft Word for Windows and draws every page to PNG with the
# Windows PDF renderer. It is the Windows counterpart of word-to-pdf.applescript + pdf-pages.js, so
# the page-comparison renderer that Word for Mac relies on can be run and checked on Windows too.
# Called by src/docx/page-exporters.ts with a job file; the documents are temporary copies.
param([Parameter(Mandatory = $true)][string]$Job)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOperation = $extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTaskAction = $extensions | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1

function Wait-Operation($operation, [Type]$type) {
  $task = $asTaskOperation.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

function Wait-Action($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  $task.Wait()
}

function Save-Pages([string]$pdf, [string]$prefix, [double]$scale) {
  $file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdf)) ([Windows.Storage.StorageFile])
  $document = Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $pages = New-Object System.Collections.ArrayList
  for ($index = 0; $index -lt $document.PageCount; $index++) {
    $page = $document.GetPage([uint32]$index)
    try {
      # Page sizes are in device-independent pixels (CSS pixels), so the scale applies directly.
      $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $options.DestinationWidth = [uint32][Math]::Ceiling($page.Size.Width * $scale)
      $options.DestinationHeight = [uint32][Math]::Ceiling($page.Size.Height * $scale)
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      Wait-Action ($page.RenderToStreamAsync($stream, $options))
      $out = "$prefix-$($index + 1).png"
      $reader = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
      $target = [System.IO.File]::Create($out)
      try { $reader.CopyTo($target) } finally { $target.Dispose(); $reader.Dispose(); $stream.Dispose() }
      [void]$pages.Add($out)
    } finally {
      $page.Dispose()
    }
  }
  return ,$pages
}

$spec = Get-Content -Raw -Encoding UTF8 -LiteralPath $Job | ConvertFrom-Json
$results = [ordered]@{}
$word = New-Object -ComObject Word.Application
# Only an instance this script started is ever quit; a Word the user had open stays as it was.
$startedHere = (-not $word.Visible) -and ($word.Documents.Count -eq 0)
try {
  if ($startedHere) { $word.DisplayAlerts = 0 }
  foreach ($entry in $spec.documents) {
    # ConfirmConversions = false, ReadOnly = true, AddToRecentFiles = false
    $document = $word.Documents.Open($entry.docx, $false, $true, $false)
    try { $document.SaveAs2([ref]$entry.pdf, [ref]17) } finally { $document.Close($false) }
  }
} finally {
  if ($startedHere) { $word.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
foreach ($entry in $spec.documents) {
  $results[$entry.name] = @(Save-Pages $entry.pdf $entry.prefix ([double]$spec.scale))
}
ConvertTo-Json -InputObject @{ pages = $results } -Depth 4 | Set-Content -LiteralPath $spec.result -Encoding UTF8
