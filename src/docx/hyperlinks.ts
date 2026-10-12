/**
 * The web addresses a Word document makes clickable. Word stores a hyperlink two ways: a
 * `<w:hyperlink r:id="…">` element whose relationship holds the address, or a HYPERLINK field
 * (`<w:instrText> HYPERLINK "…" </w:instrText>`, or `<w:fldSimple w:instr="HYPERLINK …">`). An
 * address that is only typed, even underlined, is not a hyperlink and is not listed.
 */
export function hyperlinkTargets(xml: string, relationshipsXml: string | undefined): string[] {
  const relationships = externalRelationships(relationshipsXml ?? '');
  const fromElements = [...xml.matchAll(/<w:hyperlink\b[^>]*\br:id=["']([^"']+)["']/g)].map((match) =>
    relationships.get(match[1]!)
  );
  const fromFields = [
    ...[...xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((match) => match[1]!),
    ...[...xml.matchAll(/<w:fldSimple\b[^>]*\bw:instr=["']([^"']*)["']/g)].map((match) => match[1]!)
  ].map((instruction) => /\bHYPERLINK\s+"([^"]+)"/i.exec(decodeEntities(instruction))?.[1]);
  const targets = [...fromElements, ...fromFields].filter(
    (target): target is string => target !== undefined && /^https?:\/\/\S+$/i.test(target)
  );
  return [...new Set(targets)];
}

function externalRelationships(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attributes = match[1] ?? '';
    const id = /\bId=["']([^"']*)["']/.exec(attributes)?.[1];
    const target = /\bTarget=["']([^"']*)["']/.exec(attributes)?.[1];
    if (id && target && /\bTargetMode=["']External["']/.test(attributes)) result.set(id, decodeEntities(target));
  }
  return result;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
