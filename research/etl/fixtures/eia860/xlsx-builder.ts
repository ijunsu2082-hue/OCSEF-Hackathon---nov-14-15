/**
 * Test-only builder for minimal XLSX packages (ZIP via zlib deflate). Used by
 * xlsx.test.ts and eia860.test.ts so fixtures are built in-test from readable
 * source instead of committed binaries.
 */
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../zip";

export function zipEntries(files: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const name = encoder.encode(file.name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, Buffer.from(name), compressed);
    centrals.push(central, Buffer.from(name));
    offset += 30 + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

export type CellInput = string | number | boolean | null | { xml: string };

export interface SheetInput {
  name: string;
  /** Rows from row 1; null cells are omitted. Strings go to the shared string table. */
  rows?: CellInput[][];
  /** Full worksheet XML, overriding `rows`. */
  xml?: string;
  /** Part name under xl/, default worksheets/sheetN.xml. */
  part?: string;
}

export interface BookInput {
  sheets: SheetInput[];
  /** Full sharedStrings.xml, overriding the generated table. */
  sharedStringsXml?: string;
  /** Override the workbook content type. */
  workbookContentType?: string;
  /** Extra or replacement parts. */
  extraParts?: Array<{ name: string; data: string }>;
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnLetters(column: number): string {
  let out = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) out = String.fromCharCode(65 + ((value - 1) % 26)) + out;
  return out;
}

export function buildXlsx(book: BookInput): Uint8Array {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const intern = (text: string) => {
    let at = index.get(text);
    if (at === undefined) { at = strings.length; strings.push(text); index.set(text, at); }
    return at;
  };
  const sheetParts = book.sheets.map((sheet, at) => sheet.part ?? `worksheets/sheet${at + 1}.xml`);
  const sheetXml = book.sheets.map((sheet) => {
    if (sheet.xml) return sheet.xml;
    const rows = (sheet.rows ?? []).map((cells, r) => {
      const body = cells.map((cell, c) => {
        if (cell === null) return "";
        const ref = `${columnLetters(c + 1)}${r + 1}`;
        if (typeof cell === "object") return `<c r="${ref}"${cell.xml}</c>`;
        if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
        if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="s"><v>${intern(cell)}</v></c>`;
      }).join("");
      return `<row r="${r + 1}">${body}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const shared = book.sharedStringsXml ??
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join("")}</sst>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${book.workbookContentType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"}"/>` +
    sheetParts.map((part) => `<Override PartName="/xl/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  // Relationship ids are assigned in reverse so sheet order != rId order != part order.
  const relId = (at: number) => `rId${book.sheets.length - at + 10}`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
    book.sheets.map((sheet, at) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${at + 1}" r:id="${relId(at)}"/>`).join("") + `</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    book.sheets.map((_, at) => `<Relationship Id="${relId(at)}" Type="${REL}/worksheet" Target="${sheetParts[at]}"/>`).reverse().join("") +
    `<Relationship Id="rId1" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const parts = new Map<string, string>([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", workbookRels],
    ["xl/sharedStrings.xml", shared],
    ...sheetParts.map((part, at): [string, string] => [`xl/${part}`, sheetXml[at]]),
  ]);
  for (const extra of book.extraParts ?? []) parts.set(extra.name, extra.data);
  return zipEntries([...parts].map(([name, data]) => ({ name, data })));
}
