/**
 * Characters Word stores as elements of their own inside a run rather than as `<w:t>` text: a
 * non-breaking hyphen ("well‑known"), an optional hyphen, a carriage return, and a symbol inserted
 * from a symbol font (Insert > Symbol: α, ±, °, −). Reading only `<w:t>` drops them, which runs
 * words together and loses dashes and Greek letters.
 *
 * Returns the text one such element prints: '' for an optional hyphen, which shows only at a line end.
 */
export function runCharacterText(element: string): string {
  const name = /^<w:(\w+)/.exec(element)?.[1];
  if (name === 'noBreakHyphen') return '-';
  if (name === 'softHyphen') return '';
  if (name === 'cr') return ' ';
  if (name === 'sym') return symbolText(element);
  return '';
}

/**
 * `<w:sym w:font="Symbol" w:char="F061"/>`: the Symbol font draws its own glyph at each code, so
 * the code is mapped to the character it shows. Any other font's code is the character itself.
 * A decorative font's private code (Wingdings) has no character, and reads as nothing.
 */
function symbolText(element: string): string {
  const font = /\bw:font=["']([^"']*)["']/.exec(element)?.[1] ?? '';
  const code = Number.parseInt(/\bw:char=["']([0-9A-Fa-f]+)["']/.exec(element)?.[1] ?? '', 16);
  if (Number.isNaN(code)) return '';
  const low = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  if (/^symbol$/i.test(font.trim())) return SYMBOL_FONT.get(low) ?? (low >= 0x20 && low < 0x7f ? String.fromCharCode(low) : '');
  if (code >= 0xf000 && code <= 0xf0ff) return '';
  return String.fromCodePoint(code);
}

/** Adobe Symbol encoding: the codes whose glyph differs from the ASCII character at that code. */
const SYMBOL_FONT = new Map<number, string>([
  [0x22, '∀'], [0x24, '∃'], [0x27, '∋'], [0x2a, '∗'], [0x2d, '−'], [0x40, '≅'], [0x5e, '⊥'], [0x7e, '∼'],
  ...[...'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'].map((character, index): [number, string] => [0x41 + index, character]),
  ...[...'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'].map((character, index): [number, string] => [0x61 + index, character]),
  [0xa1, 'ϒ'], [0xa2, '′'], [0xa3, '≤'], [0xa5, '∞'], [0xab, '↔'], [0xac, '←'], [0xad, '↑'], [0xae, '→'],
  [0xaf, '↓'], [0xb0, '°'], [0xb1, '±'], [0xb2, '″'], [0xb3, '≥'], [0xb4, '×'], [0xb5, '∝'], [0xb6, '∂'],
  [0xb7, '•'], [0xb8, '÷'], [0xb9, '≠'], [0xba, '≡'], [0xbb, '≈'], [0xbc, '…'], [0xc5, '⊕'], [0xc6, '∅'],
  [0xc7, '∩'], [0xc8, '∪'], [0xce, '∈'], [0xcf, '∉'], [0xd1, '∇'], [0xd6, '√'], [0xd7, '⋅'], [0xdb, '⇔'],
  [0xde, '⇒'], [0xe5, '∑'], [0xf2, '∫']
]);
