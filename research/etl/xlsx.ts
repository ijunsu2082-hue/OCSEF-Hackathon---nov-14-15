/**
 * Minimal, dependency-free XLSX (SpreadsheetML, transitional) reader on top of
 * the strict ZIP reader in ./zip.
 *
 * Published workbooks (EIA-860, EIA-860M, EIA-923) are pinned by sha256 and
 * re-read on every regeneration, so the reader is deterministic and strict
 * rather than forgiving:
 *
 *   - The package is navigated the OPC way: `_rels/.rels` names the workbook
 *     part, `[Content_Types].xml` must declare it a SpreadsheetML workbook, and
 *     `xl/_rels/workbook.xml.rels` maps each `<sheet r:id>` to its part. Nothing
 *     is located by a guessed file name.
 *   - The XML tokenizer understands elements, attributes, text, CDATA,
 *     comments and processing instructions. It rejects any DOCTYPE (so no
 *     entity declarations, no external entities, no expansion bombs) and
 *     decodes only the five predefined entities plus numeric character
 *     references. Any other `&name;` is an error.
 *   - Cell values keep the exact text the workbook stores (`raw`). `t="n"`
 *     values become numbers only when that text matches a strict decimal
 *     grammar; anything else is an error, never a silent NaN.
 *   - Sheets are parsed one at a time and lazily, row by row, from a
 *     generator. Part sizes, shared string counts, rows and columns are capped.
 */

import { readZip } from "./zip";

/* ------------------------------------------------------------------------ */
/* Limits                                                                    */
/* ------------------------------------------------------------------------ */

/** Default cap on the summed uncompressed size of every part in the package. */
export const XLSX_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Default cap on any one XML part that is decoded. */
export const XLSX_MAX_PART_BYTES = 160 * 1024 * 1024;
/** Default cap on shared string table entries. */
export const XLSX_MAX_SHARED_STRINGS = 4_000_000;
/** SpreadsheetML grid limits (Excel 2007+). */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
const MAX_DEPTH = 256;

export interface XlsxOptions {
  maxArchiveBytes?: number;
  maxPartBytes?: number;
  maxSharedStrings?: number;
}

/* ------------------------------------------------------------------------ */
/* XML tokenizer                                                             */
/* ------------------------------------------------------------------------ */

export type XmlEvent =
  | { kind: "start"; name: string; qname: string; attrs: Record<string, string> }
  | { kind: "end"; name: string }
  | { kind: "text"; text: string };

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function validCodePoint(code: number): boolean {
  // XML 1.0 Char production.
  return code === 0x9 || code === 0xa || code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/** Decode the five predefined entities and numeric character references. Anything else throws. */
export function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const amp = text.indexOf("&", cursor);
    if (amp < 0) { out += text.slice(cursor); break; }
    out += text.slice(cursor, amp);
    const semi = text.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) throw new Error(`XML has an unterminated entity reference at ${amp}`);
    const body = text.slice(amp + 1, semi);
    let replacement: string;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      if (!/^[0-9A-Fa-f]{1,6}$/.test(body.slice(2))) throw new Error(`XML has a malformed character reference &${body};`);
      const code = parseInt(body.slice(2), 16);
      if (!validCodePoint(code)) throw new Error(`XML character reference &${body}; is not a legal XML character`);
      replacement = String.fromCodePoint(code);
    } else if (body.startsWith("#")) {
      if (!/^[0-9]{1,7}$/.test(body.slice(1))) throw new Error(`XML has a malformed character reference &${body};`);
      const code = parseInt(body.slice(1), 10);
      if (!validCodePoint(code)) throw new Error(`XML character reference &${body}; is not a legal XML character`);
      replacement = String.fromCodePoint(code);
    } else {
      const named = Object.hasOwn(PREDEFINED, body) ? PREDEFINED[body] : undefined;
      if (named === undefined) throw new Error(`XML entity &${body}; is not one of the five predefined entities`);
      replacement = named;
    }
    out += replacement;
    cursor = semi + 1;
  }
  return out;
}

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_TAIL = /\s*(\/?)>/y;

function localName(qname: string): string {
  const colon = qname.indexOf(":");
  return colon < 0 ? qname : qname.slice(colon + 1);
}

/**
 * Pull tokenizer over a fully decoded XML document. Self-closing elements
 * yield a start event followed by a synthetic end event, so consumers only
 * track start/end pairs. Element names are reported by local name (namespace
 * prefix stripped); `qname` keeps the prefix. Well-formedness of nesting is
 * checked.
 */
export class XmlPullParser {
  private cursor = 0;
  private readonly stack: string[] = [];
  private pendingEnd: string | null = null;
  private sawRoot = false;

  constructor(private readonly text: string, private readonly label = "XML") {
    if (text.charCodeAt(0) === 0xfeff) this.cursor = 1;
  }

  private fail(message: string): never {
    throw new Error(`${this.label}: ${message} (offset ${this.cursor})`);
  }

  next(): XmlEvent | null {
    if (this.pendingEnd !== null) {
      const name = this.pendingEnd;
      this.pendingEnd = null;
      return { kind: "end", name };
    }
    const { text } = this;
    for (;;) {
      if (this.cursor >= text.length) {
        if (this.stack.length) this.fail(`unclosed element <${this.stack[this.stack.length - 1]}>`);
        if (!this.sawRoot) this.fail("document has no root element");
        return null;
      }
      const lt = text.indexOf("<", this.cursor);
      if (lt !== this.cursor) {
        const end = lt < 0 ? text.length : lt;
        const raw = text.slice(this.cursor, end);
        this.cursor = end;
        if (!this.stack.length) {
          if (/\S/.test(raw)) this.fail("text outside the root element");
          continue;
        }
        return { kind: "text", text: decodeXmlText(raw) };
      }
      const next = text.charCodeAt(lt + 1);
      if (next === 0x3f /* ? */) {
        const close = text.indexOf("?>", lt + 2);
        if (close < 0) this.fail("unterminated processing instruction");
        const body = text.slice(lt + 2, close);
        if (/^xml\s/.test(body)) {
          if (lt !== (text.charCodeAt(0) === 0xfeff ? 1 : 0)) this.fail("XML declaration is not at the start");
          const encoding = /encoding\s*=\s*["']([^"']+)["']/.exec(body);
          if (encoding && encoding[1].toLowerCase() !== "utf-8") this.fail(`unsupported encoding ${encoding[1]}`);
        }
        this.cursor = close + 2;
        continue;
      }
      if (next === 0x21 /* ! */) {
        if (text.startsWith("<!--", lt)) {
          const close = text.indexOf("-->", lt + 4);
          if (close < 0) this.fail("unterminated comment");
          this.cursor = close + 3;
          continue;
        }
        if (text.startsWith("<![CDATA[", lt)) {
          const close = text.indexOf("]]>", lt + 9);
          if (close < 0) this.fail("unterminated CDATA section");
          if (!this.stack.length) this.fail("CDATA outside the root element");
          this.cursor = close + 3;
          return { kind: "text", text: text.slice(lt + 9, close) };
        }
        if (/^<!DOCTYPE/i.test(text.slice(lt, lt + 9))) this.fail("DOCTYPE declarations are rejected");
        this.fail("unsupported markup declaration");
      }
      if (next === 0x2f /* / */) {
        NAME.lastIndex = lt + 2;
        const match = NAME.exec(text);
        if (!match) this.fail("malformed end tag");
        const qname = match[0];
        TAG_TAIL.lastIndex = NAME.lastIndex;
        const tail = TAG_TAIL.exec(text);
        if (!tail || tail[1]) this.fail(`malformed end tag </${qname}>`);
        const open = this.stack.pop();
        if (open !== qname) this.fail(`end tag </${qname}> does not match <${open ?? ""}>`);
        this.cursor = TAG_TAIL.lastIndex;
        return { kind: "end", name: localName(qname) };
      }
      NAME.lastIndex = lt + 1;
      const match = NAME.exec(text);
      if (!match) this.fail("malformed start tag");
      const qname = match[0];
      let position = NAME.lastIndex;
      const attrs: Record<string, string> = {};
      for (;;) {
        ATTRIBUTE.lastIndex = position;
        const attribute = ATTRIBUTE.exec(text);
        if (!attribute) break;
        const key = attribute[1];
        if (Object.prototype.hasOwnProperty.call(attrs, key)) this.fail(`duplicate attribute ${key} on <${qname}>`);
        attrs[key] = decodeXmlText(attribute[2] ?? attribute[3]);
        position = ATTRIBUTE.lastIndex;
      }
      TAG_TAIL.lastIndex = position;
      const tail = TAG_TAIL.exec(text);
      if (!tail) this.fail(`malformed start tag <${qname}>`);
      this.cursor = TAG_TAIL.lastIndex;
      if (!this.stack.length && this.sawRoot) this.fail("second root element");
      this.sawRoot = true;
      if (tail[1]) {
        this.pendingEnd = localName(qname);
      } else {
        if (this.stack.length >= MAX_DEPTH) this.fail(`elements nest deeper than ${MAX_DEPTH}`);
        this.stack.push(qname);
      }
      return { kind: "start", name: localName(qname), qname, attrs };
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Cell references and numbers                                               */
/* ------------------------------------------------------------------------ */

/** 1-based column number for letters A..XFD. */
export function columnNumber(letters: string): number {
  if (!/^[A-Z]{1,3}$/.test(letters)) throw new Error(`Invalid column letters ${letters}`);
  let value = 0;
  for (let index = 0; index < letters.length; index += 1) value = value * 26 + (letters.charCodeAt(index) - 64);
  if (value > XLSX_MAX_COLUMNS) throw new Error(`Column ${letters} is beyond XFD`);
  return value;
}

/** Column letters for a 1-based column number. */
export function columnName(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > XLSX_MAX_COLUMNS) throw new Error(`Invalid column ${column}`);
  let out = "";
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

export function parseCellRef(ref: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!match) throw new Error(`Invalid cell reference ${ref}`);
  const row = Number(match[2]);
  if (row > XLSX_MAX_ROWS) throw new Error(`Cell reference ${ref} is beyond row ${XLSX_MAX_ROWS}`);
  return { column: columnNumber(match[1]), row };
}

const STRICT_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * The strict numeric rule: the stored text must be a plain decimal (optional
 * sign, no leading zeros, optional fraction and exponent, no whitespace, no
 * hex, no NaN/Infinity) and must convert to a finite double. `Number` then
 * gives the round-to-nearest double of that exact decimal text.
 */
export function strictNumber(raw: string): number {
  if (!STRICT_NUMBER.test(raw)) throw new Error(`Not a strict decimal number: ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Number out of range: ${raw}`);
  return value;
}

/* ------------------------------------------------------------------------ */
/* Package                                                                   */
/* ------------------------------------------------------------------------ */

export type XlsxCellType = "s" | "str" | "inlineStr" | "b" | "n" | "e";

export interface XlsxCell {
  /** A1-style reference, as stored or as derived from position when `r` is absent. */
  ref: string;
  /** 1-based column. */
  column: number;
  type: XlsxCellType;
  /** Exact stored text: the `<v>` text (for `s`, the shared string index) or the inline string. */
  raw: string;
  /** Resolved value: shared/inline string, number (strict rule), boolean, or error text. */
  value: string | number | boolean;
}

export interface XlsxRow {
  /** 1-based row number. */
  row: number;
  cells: XlsxCell[];
}

export interface XlsxSheetInfo {
  name: string;
  sheetId: string;
  relationshipId: string;
  /** ZIP entry name of the sheet part, e.g. xl/worksheets/sheet1.xml. */
  part: string;
  kind: "worksheet" | "chartsheet" | "dialogsheet" | "macrosheet" | "unknown";
  state: string;
}

const REL_OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_SHARED_STRINGS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";
const WORKBOOK_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
]);
const SHEET_KINDS: Record<string, XlsxSheetInfo["kind"]> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": "worksheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": "chartsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": "dialogsheet",
  "application/vnd.ms-excel.macrosheet+xml": "macrosheet",
};

interface Relationship { id: string; type: string; target: string; external: boolean }

function partDir(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash < 0 ? "" : part.slice(0, slash + 1);
}

/** Resolve a relationship target against its source part; returns a ZIP entry name. */
function resolveTarget(sourcePart: string, target: string): string {
  const joined = target.startsWith("/") ? target.slice(1) : partDir(sourcePart) + target;
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) throw new Error(`Relationship target escapes the package: ${target}`);
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

function relsPartFor(part: string): string {
  const dir = partDir(part);
  return `${dir}_rels/${part.slice(dir.length)}.rels`;
}

export class XlsxWorkbook {
  readonly sheets: XlsxSheetInfo[];
  readonly workbookPart: string;
  private readonly parts = new Map<string, Uint8Array>();
  private readonly overrides = new Map<string, string>();
  private readonly defaults = new Map<string, string>();
  private readonly sharedStringsPart: string | null;
  private shared: string[] | null = null;
  private readonly maxPartBytes: number;
  private readonly maxSharedStrings: number;

  constructor(bytes: Uint8Array, options: XlsxOptions = {}) {
    this.maxPartBytes = options.maxPartBytes ?? XLSX_MAX_PART_BYTES;
    this.maxSharedStrings = options.maxSharedStrings ?? XLSX_MAX_SHARED_STRINGS;
    for (const entry of readZip(bytes, { maxTotalBytes: options.maxArchiveBytes ?? XLSX_MAX_ARCHIVE_BYTES })) {
      this.parts.set(entry.name, entry.data);
    }
    this.readContentTypes();
    const root = this.relationships("_rels/.rels");
    const office = root.filter((rel) => rel.type === REL_OFFICE_DOCUMENT && !rel.external);
    if (office.length !== 1) throw new Error(`XLSX package has ${office.length} officeDocument relationships; expected 1`);
    this.workbookPart = resolveTarget("", office[0].target);
    const workbookType = this.contentType(this.workbookPart);
    if (!workbookType || !WORKBOOK_TYPES.has(workbookType)) {
      throw new Error(`XLSX main part ${this.workbookPart} has content type ${workbookType ?? "(none)"}, not a SpreadsheetML workbook`);
    }
    const rels = new Map(this.relationships(relsPartFor(this.workbookPart)).map((rel) => [rel.id, rel]));
    const strings = [...rels.values()].filter((rel) => rel.type === REL_SHARED_STRINGS && !rel.external);
    if (strings.length > 1) throw new Error("XLSX workbook has more than one shared string table");
    this.sharedStringsPart = strings.length ? resolveTarget(this.workbookPart, strings[0].target) : null;
    this.sheets = this.readSheetList(rels);
  }

  private part(name: string): Uint8Array {
    const data = this.parts.get(name);
    if (!data) throw new Error(`XLSX part ${name} is missing`);
    return data;
  }

  private xml(name: string): XmlPullParser {
    const data = this.part(name);
    if (data.length > this.maxPartBytes) throw new Error(`XLSX part ${name} is ${data.length} bytes; cap is ${this.maxPartBytes}`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return new XmlPullParser(text, name);
  }

  private readContentTypes(): void {
    const parser = this.xml("[Content_Types].xml");
    for (let event = parser.next(); event; event = parser.next()) {
      if (event.kind !== "start") continue;
      if (event.name === "Default" && event.attrs.Extension && event.attrs.ContentType) {
        this.defaults.set(event.attrs.Extension.toLowerCase(), event.attrs.ContentType);
      } else if (event.name === "Override" && event.attrs.PartName && event.attrs.ContentType) {
        this.overrides.set(event.attrs.PartName.toLowerCase(), event.attrs.ContentType);
      }
    }
  }

  /** Content type of a part per [Content_Types].xml (Override first, then Default by extension). */
  contentType(part: string): string | null {
    const override = this.overrides.get(`/${part}`.toLowerCase());
    if (override) return override;
    const dot = part.lastIndexOf(".");
    return dot < 0 ? null : this.defaults.get(part.slice(dot + 1).toLowerCase()) ?? null;
  }

  private relationships(relsPart: string): Relationship[] {
    const parser = this.xml(relsPart);
    const out: Relationship[] = [];
    for (let event = parser.next(); event; event = parser.next()) {
      if (event.kind !== "start" || event.name !== "Relationship") continue;
      const { Id, Type, Target, TargetMode } = event.attrs;
      if (!Id || !Type || Target === undefined) throw new Error(`${relsPart}: Relationship lacks Id, Type or Target`);
      out.push({ id: Id, type: Type, target: Target, external: TargetMode === "External" });
    }
    return out;
  }

  private readSheetList(rels: Map<string, Relationship>): XlsxSheetInfo[] {
    const parser = this.xml(this.workbookPart);
    const sheets: XlsxSheetInfo[] = [];
    const names = new Set<string>();
    for (let event = parser.next(); event; event = parser.next()) {
      if (event.kind !== "start" || event.name !== "sheet") continue;
      const name = event.attrs.name;
      const idKey = Object.keys(event.attrs).find((key) => key.endsWith(":id"));
      const relationshipId = idKey ? event.attrs[idKey] : undefined;
      if (!name || !relationshipId) throw new Error(`${this.workbookPart}: <sheet> lacks name or r:id`);
      if (names.has(name.toLowerCase())) throw new Error(`${this.workbookPart}: duplicate sheet name ${name}`);
      names.add(name.toLowerCase());
      const rel = rels.get(relationshipId);
      if (!rel || rel.external) throw new Error(`${this.workbookPart}: sheet ${name} has no internal relationship ${relationshipId}`);
      const part = resolveTarget(this.workbookPart, rel.target);
      const type = this.contentType(part);
      sheets.push({
        name, sheetId: event.attrs.sheetId ?? "", relationshipId, part,
        kind: (type && Object.hasOwn(SHEET_KINDS, type) && SHEET_KINDS[type]) || "unknown", state: event.attrs.state ?? "visible",
      });
    }
    return sheets;
  }

  sheet(name: string): XlsxSheetInfo {
    const sheet = this.sheets.find((candidate) => candidate.name === name);
    if (!sheet) throw new Error(`XLSX has no sheet named ${JSON.stringify(name)}; sheets: ${this.sheets.map((s) => s.name).join(", ")}`);
    return sheet;
  }

  /** Shared string table, parsed once on first use. Rich-text runs are concatenated; phonetic runs are dropped. */
  sharedStrings(): string[] {
    if (this.shared) return this.shared;
    const out: string[] = [];
    if (this.sharedStringsPart) {
      const parser = this.xml(this.sharedStringsPart);
      let inItem = false;
      let phonetic = 0;
      let inText = false;
      let current = "";
      for (let event = parser.next(); event; event = parser.next()) {
        if (event.kind === "start") {
          if (event.name === "si") {
            if (inItem) throw new Error(`${this.sharedStringsPart}: nested <si>`);
            inItem = true; current = "";
          } else if (event.name === "rPh") phonetic += 1;
          else if (event.name === "t" && inItem && !phonetic) inText = true;
        } else if (event.kind === "end") {
          if (event.name === "si") {
            if (out.length >= this.maxSharedStrings) throw new Error(`Shared string table exceeds ${this.maxSharedStrings} entries`);
            out.push(current); inItem = false;
          } else if (event.name === "rPh") phonetic -= 1;
          else if (event.name === "t") inText = false;
        } else if (inText) current += event.text;
      }
    }
    this.shared = out;
    return out;
  }

  /**
   * Rows of one worksheet, in order, parsed lazily. Cells without a stored
   * value (`<c>` with only a style) are omitted. Formula cells report their
   * cached value; the formula itself is ignored.
   */
  *rows(name: string): Generator<XlsxRow> {
    const sheet = this.sheet(name);
    if (sheet.kind !== "worksheet") throw new Error(`Sheet ${name} is a ${sheet.kind}, not a worksheet`);
    const label = `${sheet.part} (${name})`;
    const parser = this.xml(sheet.part);
    let inData = false;
    let row: XlsxRow | null = null;
    let lastRow = 0;
    let lastColumn = 0;
    let cell: { ref: string; column: number; type: string } | null = null;
    let value: string | null = null;
    let inline: string | null = null;
    let capture: "v" | "t" | null = null;
    let inInline = false;
    let phonetic = 0;
    for (let event = parser.next(); event; event = parser.next()) {
      if (event.kind === "text") {
        if (capture === "v") value = (value ?? "") + event.text;
        else if (capture === "t") inline = (inline ?? "") + event.text;
        continue;
      }
      if (event.kind === "start") {
        switch (event.name) {
          case "sheetData": inData = true; break;
          case "row": {
            if (!inData || row) throw new Error(`${label}: misplaced <row>`);
            const number = event.attrs.r !== undefined ? Number(event.attrs.r) : lastRow + 1;
            if (!Number.isInteger(number) || number < 1 || number > XLSX_MAX_ROWS) throw new Error(`${label}: invalid row number ${event.attrs.r}`);
            if (number <= lastRow) throw new Error(`${label}: row ${number} is out of order after ${lastRow}`);
            row = { row: number, cells: [] };
            lastRow = number;
            lastColumn = 0;
            break;
          }
          case "c": {
            if (!row || cell) throw new Error(`${label}: misplaced <c>`);
            let column: number;
            let ref: string;
            if (event.attrs.r !== undefined) {
              const parsed = parseCellRef(event.attrs.r);
              if (parsed.row !== row.row) throw new Error(`${label}: cell ${event.attrs.r} is inside row ${row.row}`);
              column = parsed.column; ref = event.attrs.r;
            } else {
              column = lastColumn + 1; ref = `${columnName(column)}${row.row}`;
            }
            if (column <= lastColumn) throw new Error(`${label}: cell ${ref} is out of order`);
            lastColumn = column;
            cell = { ref, column, type: event.attrs.t ?? "n" };
            value = null; inline = null;
            break;
          }
          case "v": if (cell) { capture = "v"; value = value ?? ""; } break;
          case "is": if (cell) { inInline = true; inline = inline ?? ""; } break;
          case "rPh": if (inInline) phonetic += 1; break;
          case "t": if (inInline && !phonetic) capture = "t"; break;
          default: break;
        }
        continue;
      }
      switch (event.name) {
        case "sheetData": inData = false; break;
        case "v": case "t": capture = null; break;
        case "is": inInline = false; break;
        case "rPh": if (inInline) phonetic -= 1; break;
        case "c": {
          if (!cell || !row) break;
          const built = this.buildCell(label, cell, value, inline);
          if (built) row.cells.push(built);
          cell = null;
          break;
        }
        case "row": {
          if (row) yield row;
          row = null;
          break;
        }
        default: break;
      }
    }
  }

  private buildCell(label: string, cell: { ref: string; column: number; type: string }, value: string | null, inline: string | null): XlsxCell | null {
    const { ref, column, type } = cell;
    switch (type) {
      case "inlineStr":
        if (inline === null) return null;
        return { ref, column, type, raw: inline, value: inline };
      case "s": {
        if (value === null) return null;
        if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label}: cell ${ref} has invalid shared string index ${value}`);
        const strings = this.sharedStrings();
        const index = Number(value);
        if (index >= strings.length) throw new Error(`${label}: cell ${ref} references shared string ${index} of ${strings.length}`);
        return { ref, column, type, raw: value, value: strings[index] };
      }
      case "str":
        if (value === null) return null;
        return { ref, column, type, raw: value, value };
      case "b":
        if (value === null) return null;
        if (value !== "0" && value !== "1") throw new Error(`${label}: cell ${ref} has boolean value ${value}`);
        return { ref, column, type, raw: value, value: value === "1" };
      case "e":
        if (value === null) return null;
        return { ref, column, type, raw: value, value };
      case "n": {
        if (value === null) return null;
        let number: number;
        try { number = strictNumber(value); } catch (error) { throw new Error(`${label}: cell ${ref}: ${(error as Error).message}`); }
        return { ref, column, type, raw: value, value: number };
      }
      default:
        throw new Error(`${label}: cell ${ref} has unsupported type t="${type}"`);
    }
  }
}

export function openXlsx(bytes: Uint8Array, options: XlsxOptions = {}): XlsxWorkbook {
  return new XlsxWorkbook(bytes, options);
}
