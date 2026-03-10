export function normalizeHexFragment(input: string): string {
  const stripped = input.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return stripped.length > 0 ? stripped : "0";
}

export const NORM_ADDR = (column: string) =>
  `LOWER(TRIM(LEADING '0' FROM REPLACE(${column}, '0x', '')))`;
