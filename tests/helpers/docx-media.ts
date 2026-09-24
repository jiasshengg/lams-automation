/** Small valid OOXML ZIP fixture, generated without private Source-of-Truth files. */
export function mediaDocx(paragraphs: string): Buffer {
  const entries = new Map([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>'],
    ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`],
    ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/></Relationships>']
  ].map(([name, value]) => [name!, Buffer.from(value!)]));
  entries.set('word/media/chart.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const drawing = '<w:r><w:drawing><wp:inline><wp:extent cx="5715000" cy="2857500"/><wp:docPr id="1" name="Chart" descr="A &amp; B"/><a:blip r:embed="rId1"/></wp:inline></w:drawing></w:r>';
export const paragraph = (text: string, image = '') => `<w:p><w:r><w:t>${text}</w:t></w:r>${image}</w:p>`;

const textBox = (label: string) =>
  `<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>${label}</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>`;
const groupedPicture = (cx: number) =>
  `<pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="1000"/></a:xfrm></pic:spPr></pic:pic>`;

/**
 * A figure the way Word saves a grouped drawing: two pictures with text-box labels laid over
 * them, whose nested paragraphs sit inside the anchoring paragraph, and a legacy VML fallback
 * repeating the same picture.
 */
export const groupedDrawing =
  '<w:r><mc:AlternateContent><mc:Choice Requires="wpg"><w:drawing><wp:anchor>' +
  '<wp:extent cx="4000000" cy="1000000"/><wp:docPr id="2" name="Group"/>' +
  '<wpg:wgp><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000" cy="1000"/></a:xfrm></wpg:grpSpPr>' +
  `${groupedPicture(2000)}${textBox('A')}${groupedPicture(2000)}${textBox('B')}` +
  '</wpg:wgp></wp:anchor></w:drawing></mc:Choice>' +
  '<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>A</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback>' +
  '</mc:AlternateContent></w:r>';
