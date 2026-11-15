import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildXlsx } from "./fixtures/eia860/xlsx-builder";
import {
  columnName, columnNumber, decodeXmlText, openXlsx, parseCellRef, strictNumber, XmlPullParser, type XlsxRow,
} from "./xlsx";

const FIXTURES = "research/etl/fixtures/eia860";
/** LayoutY2025.xlsx exactly as published inside eia8602025.zip (sha256 of the archive: 2b27929d…08ba). */
const LAYOUT_SHA256 = "50086805d12d6529e878ddb58e3472215b274ff499f5617523d97243658ec9d5";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function sheetXml(body: string, prolog = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'): string {
  return `${prolog}<worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`;
}

function allRows(bytes: Uint8Array, sheet: string): XlsxRow[] {
  return [...openXlsx(bytes).rows(sheet)];
}

test("reads every cell type, rich text, inline strings and exact numeric text", () => {
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}">` +
    `<si><t>Plant Code</t></si>` +
    `<si><r><t>Chemical</t></r><r><rPr><sz val="10"/></rPr><t xml:space="preserve"> Manufacturing</t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si>` +
    `<si><t>A &amp; B &lt;C&gt; &#x41;&#66; &quot;q&quot; &apos;a&apos;</t></si>` +
    `<si><t/></si></sst>`;
  const sheet = sheetXml(
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>` +
    `<row r="3"><c r="A3"><v>0.1</v></c><c r="B3" t="n"><v>-1.25E-3</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="e"><v>#N/A</v></c>` +
    `<c r="E3" t="str"><f>A3*2</f><v>cached</v></c><c r="F3" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r></is></c>` +
    `<c r="G3" s="4"/><c r="AA3"><v>2025</v></c></row>` +
    // Cells and rows without `r` follow their predecessors.
    `<row><c><v>7</v></c><c t="inlineStr"><is><t><![CDATA[<raw & text>]]></t></is></c></row>`);
  const bytes = buildXlsx({ sheets: [{ name: "Data", xml: sheet }], sharedStringsXml: shared });
  const rows = allRows(bytes, "Data");
  assert.deepEqual(rows.map((row) => row.row), [1, 3, 4]);
  assert.deepEqual(rows[0].cells.map((cell) => cell.value), ["Plant Code", "Chemical Manufacturing", "A & B <C> AB \"q\" 'a'", ""]);
  assert.equal(rows[0].cells[1].raw, "1", "shared string cells keep their index as raw text");
  const third = rows[1].cells;
  assert.deepEqual(third.map((cell) => [cell.ref, cell.type, cell.raw, cell.value]), [
    ["A3", "n", "0.1", 0.1],
    ["B3", "n", "-1.25E-3", -0.00125],
    ["C3", "b", "1", true],
    ["D3", "e", "#N/A", "#N/A"],
    ["E3", "str", "cached", "cached"],
    ["F3", "inlineStr", "inline", "inline"],
    ["AA3", "n", "2025", 2025],
  ]);
  assert.equal(third[6].column, 27);
  assert.deepEqual(rows[2].cells.map((cell) => [cell.ref, cell.value]), [["A4", 7], ["B4", "<raw & text>"]]);
});

test("maps sheet names to parts through workbook relationships, not position", () => {
  const bytes = buildXlsx({
    sheets: [
      { name: "First", part: "worksheets/zz-last.xml", rows: [["one"]] },
      { name: "Second & more", part: "worksheets/aa-first.xml", rows: [["two"]] },
    ],
  });
  const book = openXlsx(bytes);
  assert.deepEqual(book.sheets.map((sheet) => [sheet.name, sheet.part, sheet.kind]), [
    ["First", "xl/worksheets/zz-last.xml", "worksheet"],
    ["Second & more", "xl/worksheets/aa-first.xml", "worksheet"],
  ]);
  assert.equal([...book.rows("Second & more")][0].cells[0].value, "two");
  assert.throws(() => [...book.rows("Third")], /no sheet named "Third"/);
});

test("rejects DOCTYPE and undeclared entities (no entity expansion)", () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>';
  const doctypeSheet = buildXlsx({ sheets: [{ name: "S", xml: sheetXml("<row r=\"1\"><c r=\"A1\"><v>1</v></c></row>", bomb) }] });
  assert.throws(() => allRows(doctypeSheet, "S"), /DOCTYPE declarations are rejected/);
  const doctypeStrings = buildXlsx({ sheets: [{ name: "S", rows: [["x"]] }], sharedStringsXml: `${bomb}<sst xmlns="${MAIN}"><si><t>&b;</t></si></sst>` });
  assert.throws(() => allRows(doctypeStrings, "S"), /DOCTYPE declarations are rejected/);
  const entity = buildXlsx({ sheets: [{ name: "S", rows: [["x"]] }], sharedStringsXml: `<sst xmlns="${MAIN}"><si><t>&nbsp;</t></si></sst>` });
  assert.throws(() => allRows(entity, "S"), /not one of the five predefined entities/);
  assert.throws(() => decodeXmlText("&#0;"), /not a legal XML character/);
  assert.throws(() => decodeXmlText("&#x110000;"), /not a legal XML character/);
  assert.throws(() => decodeXmlText("a & b"), /unterminated entity/);
  assert.equal(decodeXmlText("&#128512;"), "\u{1F600}");
});

test("the strict numeric rule", () => {
  for (const [raw, value] of [["0", 0], ["-0.5", -0.5], ["3", 3], ["1.25E+2", 125], ["9.9999999999999995E-7", 9.9999999999999995e-7], ["806", 806]] as const) {
    assert.equal(strictNumber(raw), value);
  }
  for (const raw of ["", " 1", "1 ", "01", "+1", "1.", ".5", "1e", "0x10", "NaN", "Infinity", "1,000", "1e400"]) {
    assert.throws(() => strictNumber(raw), /Not a strict decimal number|out of range/, raw);
  }
  const bad = buildXlsx({ sheets: [{ name: "S", xml: sheetXml('<row r="1"><c r="A1"><v>12 MW</v></c></row>') }] });
  assert.throws(() => allRows(bad, "S"), /cell A1: Not a strict decimal number: "12 MW"/);
  const badBool = buildXlsx({ sheets: [{ name: "S", xml: sheetXml('<row r="1"><c r="A1" t="b"><v>true</v></c></row>') }] });
  assert.throws(() => allRows(badBool, "S"), /boolean value true/);
  const unknownType = buildXlsx({ sheets: [{ name: "S", xml: sheetXml('<row r="1"><c r="A1" t="d"><v>2025-01-01</v></c></row>') }] });
  assert.throws(() => allRows(unknownType, "S"), /unsupported type t="d"/);
});

test("rejects structural problems in sheets and packages", () => {
  const cases: Array<[string, RegExp]> = [
    ['<row r="2"><c r="A2"><v>1</v></c></row><row r="1"><c r="A1"><v>1</v></c></row>', /row 1 is out of order/],
    ['<row r="1"><c r="B1"><v>1</v></c><c r="A1"><v>1</v></c></row>', /cell A1 is out of order/],
    ['<row r="1"><c r="A2"><v>1</v></c></row>', /cell A2 is inside row 1/],
    ['<row r="1"><c r="XFE1"><v>1</v></c></row>', /beyond XFD/],
    ['<row r="1"><c r="A1" t="s"><v>5</v></c></row>', /references shared string 5 of 0/],
    ['<row r="1"><c r="A1"><v>1</v></row>', /does not match/],
  ];
  for (const [body, pattern] of cases) {
    const bytes = buildXlsx({ sheets: [{ name: "S", xml: sheetXml(body) }], sharedStringsXml: `<sst xmlns="${MAIN}"></sst>` });
    assert.throws(() => allRows(bytes, "S"), pattern, body);
  }
  const notWorkbook = buildXlsx({ sheets: [{ name: "S", rows: [[1]] }], workbookContentType: "application/xml" });
  assert.throws(() => openXlsx(notWorkbook), /not a SpreadsheetML workbook/);
  const escaping = buildXlsx({
    sheets: [{ name: "S", rows: [[1]] }],
    extraParts: [{
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="../../../evil.xml"/></Relationships>`,
    }],
  });
  assert.throws(() => openXlsx(escaping), /escapes the package/);
  const big = buildXlsx({ sheets: [{ name: "S", rows: Array.from({ length: 200 }, (_, r) => [r, r * 2, r * 3]) }] });
  assert.throws(() => [...openXlsx(big, { maxPartBytes: 1024 }).rows("S")], /cap is 1024/);
  assert.throws(() => openXlsx(big, { maxArchiveBytes: 512 }), /ZIP declares more than 512 uncompressed bytes/);
  const manyStrings = buildXlsx({ sheets: [{ name: "S", rows: [["a", "b", "c"]] }] });
  assert.throws(() => [...openXlsx(manyStrings, { maxSharedStrings: 2 }).rows("S")], /exceeds 2 entries/);
  assert.throws(() => new XmlPullParser('<?xml version="1.0" encoding="UTF-16"?><a/>').next(), /unsupported encoding UTF-16/);
});

test("cell references and column letters round-trip", () => {
  for (const [letters, number] of [["A", 1], ["Z", 26], ["AA", 27], ["BU", 73], ["XFD", 16384]] as const) {
    assert.equal(columnNumber(letters), number);
    assert.equal(columnName(number), letters);
  }
  assert.deepEqual(parseCellRef("XFD1048576"), { column: 16384, row: 1048576 });
  for (const ref of ["A0", "a1", "A01", "A1048577", "1A", "AAAA1"]) assert.throws(() => parseCellRef(ref), /Invalid cell reference|beyond/, ref);
});

test("real sheet: EIA-860 2025 layout workbook as published", async () => {
  const bytes = new Uint8Array(await readFile(`${FIXTURES}/LayoutY2025.xlsx`));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), LAYOUT_SHA256);
  const book = openXlsx(bytes);
  assert.equal(book.sheets.length, 14);
  assert.equal(book.sheets[0].name, "Field Directory");
  assert.ok(book.sheets.every((sheet) => sheet.kind === "worksheet"));
  const directory = [...book.rows("Field Directory")];
  assert.equal(directory.length, 379);
  assert.match(String(directory[0].cells[0].value), /\(EIA-860\) Data Files for 2025$/);
  assert.equal(directory[2].cells[0].value, "Field Name");
  // Rich text (two runs, the second styled) concatenates to one value.
  const naics = [...book.rows("Reference Table 29")].flatMap((row) => row.cells).find((cell) => cell.ref === "B38");
  assert.equal(naics?.value, "Chemical Manufacturing (other than 32511, 32512, 325193, 3252 325211, 3253 or 325311)");
  // Status code tables, located by header text.
  const tables = [...book.rows("Reference Tables 4-6")];
  const header = tables.find((row) => row.cells.some((cell) => cell.value === "Generator Status Code"))!;
  const column = (name: string) => header.cells.find((cell) => cell.value === name)!.column;
  const codes = (name: string) => tables.filter((row) => row.row > header.row)
    .map((row) => row.cells.find((cell) => cell.column === column(name))?.value).filter((value): value is string => typeof value === "string");
  assert.deepEqual(codes("Generator Status Code"), ["OP", "SB", "OS", "OA", "RE"]);
  assert.deepEqual(codes("Proposed Generator Status Code"), ["CN", "IP", "TS", "P", "L", "T", "U", "V", "OT"]);
});

test("Object.prototype names are not predefined entities", () => {
  for (const name of ["constructor", "__proto__", "toString", "valueOf"]) {
    assert.throws(() => decodeXmlText(`a&${name};b`), /not one of the five predefined entities/, name);
  }
  const proto = buildXlsx({ sheets: [{ name: "S", rows: [["x"]] }], sharedStringsXml: `<sst xmlns="${MAIN}"><si><t>&constructor;</t></si></sst>` });
  assert.throws(() => allRows(proto, "S"), /not one of the five predefined entities/);
  assert.equal(decodeXmlText("&lt;&gt;&amp;&quot;&apos;"), "<>&\"'");
});
