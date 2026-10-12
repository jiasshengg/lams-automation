// Draws every page of a PDF to PNG with macOS's own PDFKit (JavaScript for Automation).
// Usage: osascript -l JavaScript scripts/pdf-pages.js <pdf> <output prefix> <pixels per point>
// Writes <prefix>-1.png, <prefix>-2.png, ... on a white background and prints the page count.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Quartz');

function run(argv) {
  const [pdfPath, prefix, scaleText] = argv;
  const scale = Number(scaleText);
  if (!pdfPath || !prefix || !(scale > 0)) throw new Error('Usage: pdf-pages.js <pdf> <output prefix> <pixels per point>');
  const document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(pdfPath));
  if (!document || document.isNil()) throw new Error(`Cannot open ${pdfPath} as a PDF.`);
  const mediaBox = 0; // kPDFDisplayBoxMediaBox
  const pngType = 4; // NSBitmapImageFileTypePNG
  const count = document.pageCount;
  for (let index = 0; index < count; index += 1) {
    const page = document.pageAtIndex(index);
    const bounds = page.boundsForBox(mediaBox);
    const width = Math.ceil(bounds.size.width * scale);
    const height = Math.ceil(bounds.size.height * scale);
    const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, width, height, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
    );
    const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.currentContext = context;
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, width, height));
    const graphics = context.CGContext;
    $.CGContextScaleCTM(graphics, scale, scale);
    $.CGContextTranslateCTM(graphics, -bounds.origin.x, -bounds.origin.y);
    page.drawWithBoxToContext(mediaBox, graphics);
    context.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    const png = bitmap.representationUsingTypeProperties(pngType, $());
    if (!png.writeToFileAtomically(`${prefix}-${index + 1}.png`, true)) throw new Error(`Cannot write page ${index + 1} of ${pdfPath}.`);
  }
  return String(count);
}
