import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Guards the favicon SVG served from the site root (/icon.svg) against
// active content: someone opening /icon.svg directly gets it on our
// origin, where a script in it would run. An allow-list, not a deny-list:
// only the elements and attributes a flat icon needs, each attribute's
// value in a narrow shape, and nothing else (no <!DOCTYPE>, <!ENTITY>,
// CDATA, or comments; no processing instruction but a leading <?xml ...?>
// declaration; no namespaced names; no url(...), javascript:, data:, or
// entities in any value). A small tokenizer, no XML library.
const SVG = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");

const ELEMENTS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title"]);

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const NUMBERS = /^[-+\d.eE\s,]+$/;
const PAINT = /^(none|currentColor|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+-]*$/;
const TRANSFORM = /^(\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\([-+\d.eE\s,]*\)\s*,?)+$/;

// Each allowed attribute and the shape its value must have.
const ATTRIBUTES: Record<string, RegExp> = {
  xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
  viewBox: NUMBERS,
  width: NUMBER,
  height: NUMBER,
  fill: PAINT,
  stroke: PAINT,
  "stroke-width": NUMBER,
  "stroke-linecap": /^(butt|round|square)$/,
  "stroke-linejoin": /^(miter|round|bevel)$/,
  "stroke-miterlimit": NUMBER,
  "fill-rule": /^(nonzero|evenodd)$/,
  "clip-rule": /^(nonzero|evenodd)$/,
  opacity: NUMBER,
  "fill-opacity": NUMBER,
  "stroke-opacity": NUMBER,
  d: PATH_DATA,
  points: NUMBERS,
  transform: TRANSFORM,
  x: NUMBER,
  y: NUMBER,
  x1: NUMBER,
  y1: NUMBER,
  x2: NUMBER,
  y2: NUMBER,
  rx: NUMBER,
  ry: NUMBER,
  cx: NUMBER,
  cy: NUMBER,
  r: NUMBER,
};

// Never, in any value, whatever the attribute's own shape allows.
const FORBIDDEN_IN_VALUE = /url\s*\(|javascript:|data:|&|\\/i;

const XML_DECLARATION = /^﻿?<\?xml(\s+(version|encoding|standalone)\s*=\s*("[\w.-]*"|'[\w.-]*'))*\s*\?>/;
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=<>/]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>/;
const ATTRIBUTE = /\s+([^\s=<>/]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g;

// The problems in an SVG text, empty when it is safe to serve.
function iconSvgProblems(text: string): string[] {
  const problems: string[] = [];
  let rest = text.replace(XML_DECLARATION, "");
  const open: string[] = [];
  let rootClosed = false;
  let sawRoot = false;
  while (rest.length > 0) {
    const lt = rest.indexOf("<");
    const between = lt === -1 ? rest : rest.slice(0, lt);
    // Text only inside <title>, and never markup or an entity.
    if (between.trim() !== "" && (open.at(-1) !== "title" || /[&<>]/.test(between))) problems.push(`text outside <title>: ${between.trim().slice(0, 40)}`);
    if (lt === -1) break;
    rest = rest.slice(lt);
    if (rest.startsWith("<!")) {
      problems.push(`markup declaration, CDATA, or comment: ${rest.slice(0, 20)}`);
      break;
    }
    if (rest.startsWith("<?")) {
      problems.push(`processing instruction: ${rest.slice(0, 20)}`);
      break;
    }
    const tag = TAG.exec(rest);
    if (!tag) {
      problems.push(`not an allowed tag: ${rest.slice(0, 40)}`);
      break;
    }
    const [whole, closing, name, attributes, selfClosing] = tag;
    rest = rest.slice(whole.length);
    if (!ELEMENTS.has(name)) problems.push(`element <${name}>`);
    if (closing) {
      if (attributes.trim() !== "" || selfClosing) problems.push(`malformed closing tag </${name}>`);
      if (open.pop() !== name) problems.push(`unbalanced </${name}>`);
      if (open.length === 0) rootClosed = true;
      continue;
    }
    if (rootClosed) problems.push(`content after the root element: <${name}>`);
    if (!sawRoot && name !== "svg") problems.push(`root element <${name}>, not <svg>`);
    sawRoot = true;
    const seen = new Set<string>();
    for (const [, attribute, double, single] of attributes.matchAll(ATTRIBUTE)) {
      const value = double ?? single;
      if (seen.has(attribute)) problems.push(`duplicate ${attribute} on <${name}>`);
      seen.add(attribute);
      const shape = Object.hasOwn(ATTRIBUTES, attribute) ? ATTRIBUTES[attribute] : undefined;
      if (!shape) problems.push(`attribute ${attribute} on <${name}>`);
      else if (!shape.test(value)) problems.push(`value of ${attribute} on <${name}>: ${value.slice(0, 40)}`);
      if (FORBIDDEN_IN_VALUE.test(value)) problems.push(`forbidden value of ${attribute} on <${name}>: ${value.slice(0, 40)}`);
      if (attribute === "xmlns" && name !== "svg") problems.push(`xmlns on <${name}>`);
    }
    if (name === "svg" && seen.has("xmlns") === false && open.length === 0) problems.push("no xmlns on <svg>");
    if (!selfClosing) open.push(name);
    else if (open.length === 0) rootClosed = true;
  }
  if (!sawRoot) problems.push("no <svg> root element");
  if (open.length > 0) problems.push(`unclosed <${open.join("> <")}>`);
  return problems;
}

// The real icon with `extra` inserted just inside the root element.
function withInside(extra: string): string {
  return SVG.replace(/(<svg\b[^>]*>)/, `$1\n  ${extra}`);
}

describe("icon.svg", () => {
  it("passes the allow-list", () => {
    assert.deepEqual(iconSvgProblems(SVG), []);
  });

  it("accepts a leading XML declaration", () => {
    assert.deepEqual(iconSvgProblems(`<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`), []);
  });
});

describe("iconSvgProblems rejects active content", () => {
  const bypasses: Record<string, string> = {
    "a script": withInside("<script>alert(1)</script>"),
    "a namespaced script": withInside('<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>'),
    "a namespaced attribute": withInside('<path xlink:href="#a" d="M0 0"/>'),
    "a foreignObject": withInside("<foreignObject><div/></foreignObject>"),
    "a style element": withInside("<style>path { fill: red }</style>"),
    "a style @import url(...)": withInside("<style>@import url(https://fake.example.invalid/x.css);</style>"),
    "a style attribute": withInside('<path style="fill:red" d="M0 0"/>'),
    "fill=url(https://...)": withInside('<path fill="url(https://fake.example.invalid/#g)" d="M0 0"/>'),
    "fill=url(#local)": withInside('<path fill="url(#g)" d="M0 0"/>'),
    "a set to javascript:": withInside('<set attributeName="href" to="javascript:alert(1)"/>'),
    "an animate on href": withInside('<animate attributeName="href" values="javascript:alert(1)"/>'),
    "an anchor with href": withInside('<a href="javascript:alert(1)"><path d="M0 0"/></a>'),
    "an href on an allowed element": withInside('<path href="javascript:alert(1)" d="M0 0"/>'),
    "an event handler": withInside('<path onload="alert(1)" d="M0 0"/>'),
    "an event handler in single quotes": withInside("<path onclick='alert(1)' d='M0 0'/>"),
    "an image": withInside('<image href="data:image/png;base64,AAAA"/>'),
    "a use element": withInside('<use href="#a"/>'),
    "a DOCTYPE with an ENTITY": `<!DOCTYPE svg [<!ENTITY x "javascript:alert(1)">]>\n${SVG}`,
    "an entity in a value": withInside('<path fill="&x;" d="M0 0"/>'),
    "a processing instruction": `<?xml-stylesheet href="https://fake.example.invalid/x.css"?>\n${SVG}`,
    "a processing instruction after the declaration": `<?xml version="1.0"?><?xml-stylesheet href="x.css"?>\n${SVG}`,
    "a processing instruction inside": withInside('<?php echo 1 ?>'),
    "CDATA": withInside("<title><![CDATA[<script>alert(1)</script>]]></title>"),
    "a comment": withInside("<!-- hidden -->"),
    "an upper-case SCRIPT": withInside("<SCRIPT>alert(1)</SCRIPT>"),
    "a second root element": `${SVG}\n<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
    "a non-svg root": '<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>',
    "an unquoted attribute": withInside("<path d=M0 />"),
    "a data: value": withInside('<path d="M0 0" fill="data:x"/>'),
    "a transform with url": withInside('<g transform="url(#a)"></g>'),
    "text outside title": withInside("javascript:alert(1)"),
  };

  for (const [label, text] of Object.entries(bypasses)) {
    it(label, () => {
      assert.notDeepEqual(iconSvgProblems(text), [], label);
    });
  }

  it("still accepts harmless shapes and a title", () => {
    assert.deepEqual(
      iconSvgProblems(withInside('<g transform="translate(1 2)"><rect x="1" y="1" width="2" height="2" rx="0.5" fill="#fff"/><title>unpack</title></g>')),
      [],
    );
  });
});
