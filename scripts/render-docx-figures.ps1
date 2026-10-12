# Renders bookmarked tables and figures of a DOCX to PNG with Microsoft Word, exactly as Word prints
# them. Called by src/docx/word-render.ts with a job file; never run on a user's own document: the job
# names a temporary copy, which is closed without saving.
param([Parameter(Mandatory = $true)][string]$Job)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;

public static class LamsFigure {
  // Word's picture of a range spans the whole text column; the figure is what is not white.
  public static int[] SavePng(byte[] emf, string path, float scale, int padding) {
    using (var stream = new MemoryStream(emf))
    using (var metafile = new Metafile(stream)) {
      int width = (int)Math.Ceiling(metafile.Width * scale * 96f / metafile.HorizontalResolution);
      int height = (int)Math.Ceiling(metafile.Height * scale * 96f / metafile.VerticalResolution);
      using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          graphics.Clear(Color.White);
          graphics.SmoothingMode = SmoothingMode.AntiAlias;
          graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
          graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
          graphics.DrawImage(metafile, 0, 0, width, height);
        }
        Rectangle content = InkBounds(bitmap);
        if (content.Width <= 0 || content.Height <= 0) throw new Exception("Word rendered it blank.");
        content.Inflate(padding, padding);
        content.Intersect(new Rectangle(0, 0, width, height));
        using (var cropped = bitmap.Clone(content, PixelFormat.Format24bppRgb)) {
          cropped.Save(path, ImageFormat.Png);
          return new int[] { cropped.Width, cropped.Height };
        }
      }
    }
  }

  static Rectangle InkBounds(Bitmap bitmap) {
    var area = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
    BitmapData data = bitmap.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int stride = data.Stride;
      byte[] pixels = new byte[stride * bitmap.Height];
      Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
      int left = bitmap.Width, top = bitmap.Height, right = -1, bottom = -1;
      for (int y = 0; y < bitmap.Height; y++) {
        int row = y * stride;
        for (int x = 0; x < bitmap.Width; x++) {
          int at = row + x * 4;
          if (pixels[at] < 245 || pixels[at + 1] < 245 || pixels[at + 2] < 245) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      return right < 0 ? Rectangle.Empty : Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    } finally {
      bitmap.UnlockBits(data);
    }
  }
}
"@

# The lowest point, in points from the top of its page, that the range's floating shapes reach;
# $null when it has none whose position Word states plainly.
function Get-FloatingBottom($range) {
  $bottom = $null
  foreach ($shape in $range.ShapeRange) {
    $top = [double]$shape.Top
    # Large negative values are Word's named positions (centred, inside, ...), not offsets.
    if ($top -lt -999000) { continue }
    $relative = [int]$shape.RelativeVerticalPosition
    if ($relative -eq 0) { $top += [double]$shape.Anchor.Sections.Item(1).PageSetup.TopMargin }
    elseif ($relative -eq 2 -or $relative -eq 3) { $top += [double]$shape.Anchor.Information(6) }
    elseif ($relative -ne 1) { continue }
    $shapeBottom = $top + [double]$shape.Height
    if ($null -eq $bottom -or $shapeBottom -gt $bottom) { $bottom = $shapeBottom }
  }
  return $bottom
}

# How many empty paragraphs after the range a floating figure is drawn over. They are the room the
# document left for the figure, not blank lines a reader sees.
function Get-CoveredParagraphs($range) {
  $bottom = Get-FloatingBottom $range
  if ($null -eq $bottom) { return 0 }
  $last = $range.Paragraphs.Last
  if ($last.Range.Start -ge $range.End) { $last = $last.Previous() }
  $page = $last.Range.Information(3)
  $covered = 0
  $next = $last.Next()
  while ($null -ne $next) {
    $text = $next.Range
    if ($text.Information(12)) { break }
    if (($text.Text -replace '[\s\a]', '') -ne '' -or $text.InlineShapes.Count -gt 0 -or $text.ShapeRange.Count -gt 0) { break }
    if ($text.Information(3) -ne $page -or [double]$text.Information(6) -ge $bottom - 0.5) { break }
    $covered++
    $next = $next.Next()
  }
  return $covered
}

# The figure's paragraphs split where the page turns: Word pictures a range only up to the end of
# its first page, so a collage printed across two pages becomes one picture per page. An empty
# paragraph stays with the drawings above it, so every part holds a drawing.
function Get-PageParts($paragraphs) {
  $parts = New-Object System.Collections.ArrayList
  $current = $null
  for ($offset = 0; $offset -lt $paragraphs.Count; $offset++) {
    $paragraph = $paragraphs[$offset]
    $page = [int]$paragraph.Range.Information(3)
    $drawn = ($paragraph.Range.ShapeRange.Count + $paragraph.Range.InlineShapes.Count) -gt 0
    if ($null -eq $current -or ($drawn -and $page -ne $current.page)) {
      $current = @{ first = $offset; last = $offset; page = $page }
      [void]$parts.Add($current)
    } else {
      $current.last = $offset
    }
  }
  return ,$parts
}

function Save-RangePicture($range, [string]$path) {
  $bits = $range.EnhMetaFileBits
  if ($null -eq $bits) { throw "Word returned no picture." }
  return [LamsFigure]::SavePng([byte[]]$bits, $path, [float]$spec.scale, 6)
}

function Get-PartPath([string]$path, [int]$number, [int]$count) {
  if ($count -le 1) { return $path }
  return [System.IO.Path]::ChangeExtension($path, $null).TrimEnd('.') + "-p$number.png"
}

# Node writes the job as UTF-8; Windows PowerShell would otherwise read it in the ANSI code page.
$spec = Get-Content -Raw -Encoding UTF8 -LiteralPath $Job | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList
$wdColorWhite = 16777215

$word = New-Object -ComObject Word.Application
# Word hands automation its running instance when the user already has it open. That instance and
# its documents are the user's: only an instance this script started is ever quit.
$startedHere = (-not $word.Visible) -and ($word.Documents.Count -eq 0)
try {
  if ($startedHere) { $word.DisplayAlerts = 0 }
  # ConfirmConversions = false, ReadOnly = false (text is whitened in this copy), AddToRecentFiles = false
  $document = $word.Documents.Open($spec.docx, $false, $false, $false)
  try {
    # The picture shows the document as finally printed: no tracked changes and no comment balloons.
    $document.TrackRevisions = $false
    if ($document.Revisions.Count -gt 0) { $document.AcceptAllRevisions() }
    if ($document.Comments.Count -gt 0) { $document.DeleteAllComments() }
    $document.Bookmarks.ShowHidden = $true
    foreach ($target in $spec.targets) {
      try {
        if (-not $document.Bookmarks.Exists($target.bookmark)) { throw "Its bookmark was not found in the copy Word opened." }
        $range = $document.Bookmarks.Item($target.bookmark).Range
        $covered = 0
        $parts = New-Object System.Collections.ArrayList
        if ($target.kind -eq 'table' -and $range.Tables.Count -lt 1) {
          # Columns laid out with tab stops: the lines themselves are the table Word prints.
          $paragraphs = @($range.Paragraphs | Where-Object { $_.Range.Start -lt $range.End })
          if ($paragraphs.Count -ne [int]$target.paragraphs) {
            throw "Word read $($paragraphs.Count) paragraphs where the document has $($target.paragraphs)."
          }
          $lines = $document.Range($paragraphs[0].Range.Start, $paragraphs[$paragraphs.Count - 1].Range.End)
          if ($lines.Information(3) -ne $document.Range($lines.Start, $lines.Start).Information(3)) {
            throw "The table runs onto a second page, and Word pictures only one page of it."
          }
          $size = Save-RangePicture $lines $target.out
          [void]$parts.Add([ordered]@{ first = 0; last = $paragraphs.Count - 1; out = $target.out; width = $size[0]; height = $size[1] })
        } elseif ($target.kind -eq 'table') {
          $table = $range.Tables.Item(1).Range
          $startPage = $document.Range($table.Start, $table.Start).Information(3)
          if ($table.Information(3) -ne $startPage) { throw "The table runs onto a second page, and Word pictures only one page of it." }
          $size = Save-RangePicture $table $target.out
          [void]$parts.Add([ordered]@{ first = 0; last = 0; out = $target.out; width = $size[0]; height = $size[1] })
        } else {
          $covered = Get-CoveredParagraphs $range
          # The words around the figure stay in the prompt as text; only the drawing is pictured.
          $range.Font.Color = $wdColorWhite
          $paragraphs = @($range.Paragraphs | Where-Object { $_.Range.Start -lt $range.End })
          if ($paragraphs.Count -ne [int]$target.paragraphs) {
            throw "Word read $($paragraphs.Count) paragraphs where the document has $($target.paragraphs)."
          }
          $pageParts = Get-PageParts $paragraphs
          $number = 0
          foreach ($part in $pageParts) {
            $number++
            $out = Get-PartPath $target.out $number $pageParts.Count
            $partRange = $document.Range($paragraphs[$part.first].Range.Start, $paragraphs[$part.last].Range.End)
            $size = Save-RangePicture $partRange $out
            [void]$parts.Add([ordered]@{ first = $part.first; last = $part.last; out = $out; width = $size[0]; height = $size[1] })
          }
        }
        [void]$results.Add([ordered]@{ id = $target.id; ok = $true; parts = @($parts); coveredAfter = $covered })
      } catch {
        [void]$results.Add([ordered]@{ id = $target.id; ok = $false; error = $_.Exception.Message })
      }
    }
  } finally {
    $document.Close($false)
  }
} finally {
  if ($startedHere) { $word.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}

ConvertTo-Json -InputObject @{ results = @($results) } -Depth 6 | Set-Content -LiteralPath $spec.result -Encoding UTF8
