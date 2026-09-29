/** Compare library labels without changing their stored/displayed spelling. */
export function normaliseLibraryName(value: string): string {
  return value.replace(/\s+/gu, '').toLowerCase();
}

/** Anchored full-label match; punctuation is literal and whitespace is optional anywhere. */
export function libraryNamePattern(value: string): RegExp {
  const characters = [...normaliseLibraryName(value)].map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*${characters.join('\\s*')}\\s*$`, 'iu');
}
