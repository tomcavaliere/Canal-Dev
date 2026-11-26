// Rendu Markdown des fichiers déposés (files.js). Sûr par construction : il produit des nœuds DOM
// (textContent), jamais de HTML ; une balise écrite dans le fichier s'affiche telle quelle. Seuls les
// liens http(s) et mailto deviennent cliquables (nouvel onglet). Les images ne sont pas chargées :
// elles deviennent un lien.
// Couvre l'essentiel : titres, paragraphes, listes (imbriquées par l'indentation, cases à cocher),
// citations, blocs de code, traits, tableaux, gras, italique, barré, code et liens.

const SAFE_URL = /^(https?:|mailto:)/i;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*))?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * @param {string} src texte Markdown
 * @returns {DocumentFragment}
 */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  blocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), frag);
  return frag;
}

/**
 * @param {string} tag
 * @param {string} [text]
 * @returns {any} élément du type demandé (champ, lien…)
 */
function el(tag, text) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

const indentOf = (line) => /^ */.exec(line)[0].length;

function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && TABLE_SEP.test(lines[i + 1]);
}

// La ligne i commence-t-elle un autre bloc (fin du paragraphe en cours) ?
function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || isTableStart(lines, i)
    || (LIST.test(l) && Boolean(LIST.exec(l)[3]));
}

/**
 * @param {string[]} lines
 * @param {ParentNode} parent
 */
function blocks(lines, parent) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const body = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence); i++) body.push(lines[i]);
      i++;
      const code = el("code", body.join("\n"));
      if (m[2]) code.dataset.lang = m[2];
      const pre = el("pre");
      pre.append(code);
      parent.append(pre);
      continue;
    }
    m = HEADING.exec(line);
    if (m) {
      const h = el("h" + m[1].length);
      inline(m[2] ?? "", h);
      parent.append(h);
      i++;
      continue;
    }
    if (HR.test(line)) {
      parent.append(el("hr"));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      const q = el("blockquote");
      blocks(body, q);
      parent.append(q);
      continue;
    }
    if (LIST.test(line)) {
      i = list(lines, i, parent);
      continue;
    }
    if (isTableStart(lines, i)) {
      i = table(lines, i, parent);
      continue;
    }
    const body = [line];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) body.push(lines[i]);
    const p = el("p");
    paragraph(body, p);
    parent.append(p);
  }
}

// Lignes d'un paragraphe : un retour à la ligne devient une espace, sauf après deux espaces ou « \ ».
function paragraph(lines, parent) {
  lines.forEach((l, k) => {
    const hard = k < lines.length - 1 && (/ {2,}$/.test(l) || /\\$/.test(l));
    inline(hard ? l.replace(/(?: +|\\)$/, "") : l.trim(), parent);
    if (k < lines.length - 1) parent.append(hard ? el("br") : " ");
  });
}

/**
 * Liste commençant à la ligne i ; renvoie l'indice de la première ligne qui n'en fait pas partie.
 * @param {string[]} lines
 * @param {number} i
 * @param {ParentNode} parent
 */
function list(lines, i, parent) {
  const first = LIST.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const ul = el(ordered ? "ol" : "ul");
  if (ordered && parseInt(first[2], 10) !== 1) ul.setAttribute("start", String(parseInt(first[2], 10)));
  while (i < lines.length) {
    // Ligne vide entre deux éléments de la même liste : la liste continue.
    if (!lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? LIST.exec(lines[j]) : null;
      if (!next || next[1].length !== indent || /\d/.test(next[2]) !== ordered) break;
      i = j;
    }
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const width = indent + m[2].length + 1;
    const body = [m[3] ?? ""];
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) {
        // Ligne vide suivie d'une ligne indentée : l'élément continue (paragraphe, sous-liste, code).
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > indent) {
          body.push("");
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind > indent) {
        body.push(l.slice(Math.min(ind, width)));
        continue;
      }
      if (startsBlock(lines, i) || LIST.test(l)) break;
      body.push(l.trim()); // suite « paresseuse » du texte de l'élément
    }
    const li = el("li");
    const task = /^\[([ xX])\] +/.exec(body[0]);
    if (task) {
      li.className = "md-task";
      const box = el("input");
      box.type = "checkbox";
      box.checked = task[1] !== " ";
      box.disabled = true;
      li.append(box, " ");
      body[0] = body[0].slice(task[0].length);
    }
    // Élément simple : son texte ; sinon (sous-liste, plusieurs paragraphes…) : des blocs.
    const nested = body.slice(1).some((l) => !l.trim() || LIST.test(l) || FENCE.test(l) || QUOTE.test(l) || HEADING.test(l));
    if (!nested) paragraph(body, li);
    else {
      const head = [];
      while (body.length && body[0].trim() && !(head.length && (LIST.test(body[0]) || FENCE.test(body[0])))) head.push(body.shift());
      paragraph(head, li);
      blocks(body, li);
    }
    ul.append(li);
  }
  parent.append(ul);
  return i;
}

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function table(lines, i, parent) {
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
  const t = el("table");
  const row = (values, tag) => {
    const tr = el("tr");
    head.forEach((_, k) => {
      const c = el(tag);
      if (align[k]) c.style.textAlign = align[k];
      inline(values[k] ?? "", c);
      tr.append(c);
    });
    return tr;
  };
  const thead = el("thead");
  thead.append(row(head, "th"));
  const tbody = el("tbody");
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) tbody.append(row(cells(lines[i]), "td"));
  t.append(thead, tbody);
  const wrap = el("div");
  wrap.className = "md-table";
  wrap.append(t);
  parent.append(wrap);
  return i;
}

/* ---------- Texte en ligne ---------- */

// Motifs essayés aux caractères spéciaux, ancrés à la position courante (drapeau y). Les longueurs sont
// bornées : un « * » ou un « ` » sans partenaire ne fait pas parcourir tout le fichier à chaque fois.
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~<>])/y;
const CODE = /(`+)([^\n]{0,500}?[^`\n]|[^`\n])\1(?!`)/y;
const IMAGE = /!\[([^\]\n]{0,500})\]\(\s*<?([^\s()<>]{1,2000})>?(?:\s+"[^"\n]{0,500}")?\s*\)/y;
const LINK = /\[((?:[^[\]\n]|\[[^\]\n]{0,200}\]){0,500})\]\(\s*<?([^\s()<>]{1,2000})>?(?:\s+"[^"\n]{0,500}")?\s*\)/y;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]{1,2000})>/y;
const BARE_URL = /https?:\/\/[^\s<]{0,2000}[^\s<.,:;"')\]!?*_]/y;
const STRONG = /(\*\*|__)(?=\S)([^\n]{0,500}?\S)\1/y;
const DEL = /~~(?=\S)([^\n]{0,500}?\S)~~/y;
const EM = /([*_])(?=\S)([^\n]{0,500}?\S)\1/y;
const SPECIAL = /[\\`!*_~<[h]/;

/** @param {RegExp} re @param {string} s @param {number} i */
function at(re, s, i) {
  re.lastIndex = i;
  return re.exec(s);
}

function link(out, url, label) {
  if (!SAFE_URL.test(url)) {
    inline(label, out, true);
    return;
  }
  const a = el("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  inline(label, a, true); // pas de lien dans un lien
  out.append(a);
}

/**
 * @param {string} s
 * @param {ParentNode} out
 * @param {boolean} [inLink] texte d'un lien : les adresses n'y deviennent pas des liens
 */
function inline(s, out, inLink = false) {
  let buf = "";
  const flush = () => {
    if (buf) out.append(buf);
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (!SPECIAL.test(ch)) {
      buf += ch;
      i++;
      continue;
    }
    const prev = i ? s[i - 1] : " ";
    let m;
    if (ch === "\\" && (m = at(ESCAPE, s, i))) {
      buf += m[1];
    } else if (ch === "`" && (m = at(CODE, s, i))) {
      flush();
      out.append(el("code", m[2].replace(/^ (.+) $/, "$1")));
    } else if (ch === "!" && !inLink && (m = at(IMAGE, s, i))) {
      flush();
      link(out, m[2], "🖼 " + (m[1] || m[2]));
    } else if (ch === "[" && !inLink && (m = at(LINK, s, i))) {
      flush();
      link(out, m[2], m[1]);
    } else if (ch === "<" && !inLink && (m = at(AUTOLINK, s, i))) {
      flush();
      link(out, m[1], m[1]);
    } else if (ch === "h" && !inLink && !/[\p{L}\p{N}]/u.test(prev) && (m = at(BARE_URL, s, i))) {
      flush();
      const a = el("a", m[0]);
      a.href = m[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      out.append(a);
    } else if ((ch === "*" || ch === "_") && (m = at(STRONG, s, i)) && (ch === "*" || !/[\p{L}\p{N}]/u.test(prev))) {
      flush();
      const b = el("strong");
      inline(m[2], b, inLink);
      out.append(b);
    } else if (ch === "~" && (m = at(DEL, s, i))) {
      flush();
      const d = el("del");
      inline(m[1], d, inLink);
      out.append(d);
    } else if ((ch === "*" || ch === "_") && (m = at(EM, s, i)) && (ch === "*" || !/[\p{L}\p{N}]/u.test(prev))) {
      flush();
      const e = el("em");
      inline(m[2], e, inLink);
      out.append(e);
    } else {
      buf += ch;
      i++;
      continue;
    }
    i += m[0].length;
  }
  flush();
}
