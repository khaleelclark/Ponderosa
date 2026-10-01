import { crc32, deflateRawSync } from "node:zlib";

export const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const basicDocxXml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX preview heading</w:t></w:r></w:p><w:p><w:r><w:t>Document text &amp; escaped &lt;script&gt; stays inert.</w:t></w:r><w:hyperlink><w:r><w:t> External link label</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;

/** Valid small OOXML package, or deliberately false-size compressed bomb. */
export function docxFixture(xml = basicDocxXml, { compressed = true, declaredSize, duplicate = false } = {}) {
  const document = ["word/document.xml", xml];
  const entries = [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    document, ...(duplicate ? [document] : []),
  ];
  const local = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), body = Buffer.from(text), crc = crc32(body);
    const data = compressed ? deflateRawSync(body) : body, size = name === document[0] ? declaredSize ?? body.length : body.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(compressed ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
